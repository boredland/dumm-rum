import {
	and,
	count,
	eq,
	getTableColumns,
	isNotNull,
	or,
	sql,
} from "drizzle-orm";
import type { Db } from "../db/client";
import { coalesce, excluded, max } from "../db/helpers";
import {
	departures,
	haikus,
	journeyRuns,
	journeyStops,
	knownStops,
	lineDailyStats,
	operatorDailyStats,
	stationDailyStats,
} from "../db/schema";
import { createHafasClient } from "./hafas";
import type { components } from "./hafas-types";
import {
	avgDelaySql,
	delayedDistinctSql,
	delayedSql,
	ghostSql,
} from "./queries";
import type { Station } from "./stations";
import { STATIONS } from "./stations";
import {
	DELAY_THRESHOLD_MIN,
	delayMinutes,
	nowBerlin,
	todayBerlin,
} from "./utils";

type Departure = components["schemas"]["Departure"];

const EXCLUDE_CATEGORIES = new Set(["ICE", "IC", "EC"]);
async function collectDepartures(
	db: Db,
	apiKey: string,
	station: Station,
): Promise<number> {
	const client = createHafasClient(apiKey);
	const start = nowBerlin();

	const { data, error } = await client.GET("/departureBoard", {
		params: {
			query: {
				type: "DEP",
				id: station.id,
				date: start.format("YYYY-MM-DD"),
				time: start.format("HH:mm"),
				duration: 120,
				maxJourneys: -1,
				format: "json",
			},
		},
	});

	if (error || !data) {
		console.error("HAFAS API error:", error);
		return 0;
	}

	const stationExcludes = station.excludeCategories
		? new Set(station.excludeCategories)
		: null;
	const deps = (data.Departure ?? []).filter(
		(d: Departure) =>
			d.ProductAtStop?.line &&
			d.ProductAtStop?.num &&
			!EXCLUDE_CATEGORIES.has(d.ProductAtStop?.catOut ?? "") &&
			!stationExcludes?.has(d.ProductAtStop?.catOut ?? "") &&
			!/N$/.test(d.ProductAtStop?.line ?? ""),
	);
	if (deps.length === 0) return 0;

	const now = new Date().toISOString();

	const toRow = (dep: Departure) => {
		const p = dep.ProductAtStop!;
		return {
			stationId: station.id,
			date: dep.date,
			time: dep.time,
			rtDate: dep.rtDate ?? null,
			rtTime: dep.rtTime ?? null,
			line: p.line!,
			direction: dep.direction ?? "",
			cancelled: dep.cancelled ? 1 : 0,
			operator: p.operator ?? null,
			category: p.catOut ?? null,
			journeyNum: p.num!,
			journeyRef: dep.JourneyDetailRef?.ref ?? null,
			journeyStatus: dep.JourneyStatus ?? null,
			stop: dep.stop ?? null,
			ghost: 0,
			notified: 0,
			fetchedAt: now,
		};
	};
	// https://developers.cloudflare.com/d1/platform/limits/
	// Drizzle binds one parameter per non-autoincrement column, including
	// columns omitted from `.values()` that fall back to a schema default.
	// Counting `Object.keys(toRow(...))` undercounts and overflows the limit.
	const D1_MAX_PARAMS = 100;
	const colCount = Object.keys(getTableColumns(departures)).length - 1;
	const batchSize = Math.max(1, Math.floor(D1_MAX_PARAMS / colCount));

	for (let i = 0; i < deps.length; i += batchSize) {
		const batch = deps.slice(i, i + batchSize);
		try {
			await db
				.insert(departures)
				.values(batch.map(toRow))
				.onConflictDoUpdate({
					target: [
						departures.stationId,
						departures.date,
						departures.time,
						departures.line,
						departures.direction,
						departures.journeyNum,
					],
					set: {
						rtDate: coalesce(excluded(departures.rtDate), departures.rtDate),
						rtTime: coalesce(excluded(departures.rtTime), departures.rtTime),
						journeyRef: coalesce(
							excluded(departures.journeyRef),
							departures.journeyRef,
						),
						// Once RMV has reported a meaningful status (R/A/S), keep it.
						// After a journey passes, the status fades back to 'P' — we want
						// to remember that it was tracked / additional / substituted.
						journeyStatus: sql`CASE
							WHEN ${departures.journeyStatus} IN ('R','A','S') THEN ${departures.journeyStatus}
							WHEN ${excluded(departures.journeyStatus)} IN ('R','A','S') THEN ${excluded(departures.journeyStatus)}
							ELSE COALESCE(${excluded(departures.journeyStatus)}, ${departures.journeyStatus})
						END`,
						cancelled: max(
							departures.cancelled,
							excluded(departures.cancelled),
						),
						ghost: sql`CASE WHEN ${excluded(departures.rtTime)} IS NOT NULL THEN 0 ELSE ${departures.ghost} END`,
						notified: sql`CASE WHEN ${departures.notified} = 1 AND (
							MAX(${excluded(departures.cancelled)}, ${departures.cancelled}) != ${departures.cancelled}
							OR (
								${excluded(departures.rtTime)} IS NOT NULL AND ${excluded(departures.rtDate)} IS NOT NULL
								AND ABS(
									(strftime('%s', ${excluded(departures.rtDate)} || ' ' || ${excluded(departures.rtTime)}) - strftime('%s', ${departures.date} || ' ' || ${departures.time})) / 60.0
									- COALESCE((strftime('%s', ${departures.rtDate} || ' ' || ${departures.rtTime}) - strftime('%s', ${departures.date} || ' ' || ${departures.time})) / 60.0, 0)
								) >= 5
							)
						) THEN 0 ELSE ${departures.notified} END`,
						fetchedAt: sql`CASE WHEN
							${coalesce(excluded(departures.rtDate), sql`''`)} != ${coalesce(departures.rtDate, sql`''`)}
							OR ${coalesce(excluded(departures.rtTime), sql`''`)} != ${coalesce(departures.rtTime, sql`''`)}
							OR ${excluded(departures.cancelled)} != ${departures.cancelled}
							THEN ${excluded(departures.fetchedAt)} ELSE ${departures.fetchedAt} END`,
					},
				});
		} catch (e) {
			const cause = e instanceof Error ? e.cause : undefined;
			console.error(
				`Batch insert failed for ${station.slug}:`,
				e,
				...(cause ? ["\nCause:", cause] : []),
			);
		}
	}

	return deps.length;
}

function extractHaiku(response: unknown): string | undefined {
	const result = response as Record<string, unknown>;
	return (
		(result.response as string) ??
		(result.choices as { message: { content: string } }[])?.[0]?.message
			?.content
	)?.trim();
}

async function getYesterdayWorstCategory(db: Db): Promise<string> {
	const yesterday = nowBerlin().subtract(1, "day").format("YYYY-MM-DD");
	const rows = await db
		.select({
			category: departures.category,
			cancelled: sql<number>`SUM(${departures.cancelled})`.as("cancelled"),
		})
		.from(departures)
		.where(and(eq(departures.date, yesterday), isNotNull(departures.category)))
		.groupBy(departures.category)
		.orderBy(sql`cancelled DESC`)
		.limit(1);
	return rows[0]?.category ?? "Bus";
}

const CATEGORY_THEMES: Record<string, { en: string; de: string }> = {
	Bus: {
		en: "waiting at a bus stop, not knowing if the bus was cancelled or if it ever existed. Theme: missing buses, uncertainty, urban melancholy.",
		de: "das Warten an einer Bushaltestelle, ohne zu wissen ob der Bus ausfällt oder ob es ihn je gab. Thema: fehlende Busse, Ungewissheit, urbane Melancholie.",
	},
	"U-Bahn": {
		en: "standing on an empty underground platform, staring at a departure board that keeps changing. Theme: delayed U-Bahn trains, echoing tunnels, frustrated commuters.",
		de: "das Stehen auf einem leeren U-Bahn-Bahnsteig und Starren auf eine Anzeigetafel, die sich ständig ändert. Thema: verspätete U-Bahnen, hallende Tunnel, frustrierte Pendler.",
	},
	Tram: {
		en: "watching tram tracks disappear into fog, wondering if the next tram will come. Theme: unreliable trams, empty rails, quiet streets.",
		de: "Straßenbahnschienen, die im Nebel verschwinden, und die Frage, ob die nächste Bahn kommt. Thema: unzuverlässige Straßenbahnen, leere Gleise, stille Straßen.",
	},
	S: {
		en: "a crowded S-Bahn platform where the display just switched to 'cancelled'. Theme: S-Bahn chaos, packed platforms, daily struggle.",
		de: "einen überfüllten S-Bahn-Bahnsteig, auf dem die Anzeige gerade auf 'fällt aus' umspringt. Thema: S-Bahn-Chaos, volle Bahnsteige, täglicher Kampf.",
	},
	RE: {
		en: "a regional express train that was supposed to arrive 20 minutes ago. Theme: delayed regional trains, empty platforms, broken promises.",
		de: "einen Regionalexpress, der vor 20 Minuten hätte kommen sollen. Thema: verspätete Regionalzüge, leere Bahnsteige, gebrochene Versprechen.",
	},
	RB: {
		en: "a regional train that quietly disappeared from the departure board. Theme: cancelled Regionalbahn, rural isolation, vanishing connections.",
		de: "eine Regionalbahn, die leise von der Anzeigetafel verschwunden ist. Thema: ausgefallene Regionalbahn, ländliche Isolation, verlorene Anschlüsse.",
	},
};

const DEFAULT_THEME = {
	en: "waiting for public transport that never comes in Frankfurt. Theme: cancelled trains, urban melancholy, commuter despair.",
	de: "das Warten auf öffentliche Verkehrsmittel, die in Frankfurt nie kommen. Thema: ausgefallene Züge, urbane Melancholie, Pendler-Verzweiflung.",
};

async function generateDailyHaiku(db: Db, ai: Ai): Promise<void> {
	const today = todayBerlin();
	const existing = await db
		.select({ date: haikus.date })
		.from(haikus)
		.where(eq(haikus.date, today))
		.limit(1);
	if (existing.length > 0) return;

	const worstCategory = await getYesterdayWorstCategory(db);
	const theme = CATEGORY_THEMES[worstCategory] ?? DEFAULT_THEME;

	const [enResponse, deResponse] = await Promise.all([
		ai.run("@cf/ibm-granite/granite-4.0-h-micro", {
			messages: [
				{
					role: "system",
					content:
						"You write haikus (5-7-5 syllables). Respond with ONLY the haiku, nothing else. No quotes, no explanation, no title.",
				},
				{ role: "user", content: `Write a haiku about ${theme.en}` },
			],
			max_tokens: 100,
		}),
		ai.run("@cf/ibm-granite/granite-4.0-h-micro", {
			messages: [
				{
					role: "system",
					content:
						"Du schreibst Haikus (5-7-5 Silben) auf Deutsch. Antworte NUR mit dem Haiku, nichts anderes. Keine Anführungszeichen, keine Erklärung, kein Titel.",
				},
				{
					role: "user",
					content: `Schreibe ein Haiku über ${theme.de}`,
				},
			],
			max_tokens: 100,
		}),
	]);

	const haiku = extractHaiku(enResponse);
	const haikuDe = extractHaiku(deResponse);
	if (!haiku) {
		console.error("Haiku generation returned empty response", enResponse);
		return;
	}
	console.log(`Generated haiku (en): ${haiku}`);
	if (haikuDe) console.log(`Generated haiku (de): ${haikuDe}`);

	await db
		.insert(haikus)
		.values({ date: today, haiku, haikuDe: haikuDe ?? null })
		.onConflictDoNothing();
}

async function materializeStationStats(db: Db, date: string): Promise<void> {
	const rows = await db
		.select({
			stationId: departures.stationId,
			total: count().as("total"),
			cancelled: sql<number>`SUM(${departures.cancelled})`.as("cancelled"),
			ghost: ghostSql.as("ghost"),
			delayed: delayedSql.as("delayed"),
			avgDelay: avgDelaySql.as("avg_delay"),
		})
		.from(departures)
		.where(eq(departures.date, date))
		.groupBy(departures.stationId);

	await Promise.all(
		rows.map((row) =>
			db
				.insert(stationDailyStats)
				.values({
					stationId: row.stationId,
					date,
					total: row.total,
					cancelled: row.cancelled,
					ghost: row.ghost,
					delayed: row.delayed,
					avgDelay: row.avgDelay,
				})
				.onConflictDoUpdate({
					target: [stationDailyStats.stationId, stationDailyStats.date],
					set: {
						total: row.total,
						cancelled: row.cancelled,
						ghost: row.ghost,
						delayed: row.delayed,
						avgDelay: row.avgDelay,
					},
				}),
		),
	);
}

async function materializeOperatorStats(db: Db, date: string): Promise<void> {
	const [jrRows, delayRows] = await Promise.all([
		db
			.select({
				operator: journeyRuns.operator,
				total: count().as("total"),
				cancelled: sql<number>`SUM(${journeyRuns.cancelled})`.as("cancelled"),
				ghost:
					sql<number>`SUM(CASE WHEN ${journeyRuns.wasTracked} = 0 AND ${journeyRuns.cancelled} = 0 THEN 1 ELSE 0 END)`.as(
						"ghost",
					),
			})
			.from(journeyRuns)
			.where(
				and(
					eq(journeyRuns.dayOfOperation, date),
					isNotNull(journeyRuns.operator),
				),
			)
			.groupBy(journeyRuns.operator),
		db
			.select({
				operator: departures.operator,
				delayed: delayedDistinctSql.as("delayed"),
				avgDelay: avgDelaySql.as("avg_delay"),
			})
			.from(departures)
			.where(and(eq(departures.date, date), isNotNull(departures.operator)))
			.groupBy(departures.operator),
	]);

	const delayMap = new Map(delayRows.map((d) => [d.operator, d]));
	const rows = jrRows.map((jr) => ({
		...jr,
		delayed: delayMap.get(jr.operator!)?.delayed ?? 0,
		avgDelay: delayMap.get(jr.operator!)?.avgDelay ?? null,
	}));

	await Promise.all(
		rows.map((row) =>
			db
				.insert(operatorDailyStats)
				.values({
					operator: row.operator!,
					date,
					total: row.total,
					cancelled: row.cancelled,
					ghost: row.ghost,
					delayed: row.delayed,
					avgDelay: row.avgDelay,
				})
				.onConflictDoUpdate({
					target: [operatorDailyStats.operator, operatorDailyStats.date],
					set: {
						total: row.total,
						cancelled: row.cancelled,
						ghost: row.ghost,
						delayed: row.delayed,
						avgDelay: row.avgDelay,
					},
				}),
		),
	);
}

async function materializeLineStats(db: Db, date: string): Promise<void> {
	const [jrRows, depRows] = await Promise.all([
		db
			.select({
				line: journeyRuns.line,
				category: journeyRuns.category,
				total: count().as("total"),
				cancelled: sql<number>`SUM(${journeyRuns.cancelled})`.as("cancelled"),
				ghost:
					sql<number>`SUM(CASE WHEN ${journeyRuns.wasTracked} = 0 AND ${journeyRuns.cancelled} = 0 THEN 1 ELSE 0 END)`.as(
						"ghost",
					),
			})
			.from(journeyRuns)
			.where(eq(journeyRuns.dayOfOperation, date))
			.groupBy(journeyRuns.line, journeyRuns.category),
		db
			.select({
				line: departures.line,
				delayed: delayedDistinctSql.as("delayed"),
				avgDelay: avgDelaySql.as("avg_delay"),
				operators:
					sql<string>`GROUP_CONCAT(DISTINCT ${departures.operator})`.as(
						"operators",
					),
				destinations:
					sql<string>`GROUP_CONCAT(DISTINCT ${departures.direction})`.as(
						"destinations",
					),
			})
			.from(departures)
			.where(and(eq(departures.date, date), isNotNull(departures.operator)))
			.groupBy(departures.line),
	]);

	const depMap = new Map(depRows.map((d) => [d.line, d]));
	const rows = jrRows.map((jr) => {
		const dep = depMap.get(jr.line);
		return {
			...jr,
			delayed: dep?.delayed ?? 0,
			avgDelay: dep?.avgDelay ?? null,
			operators: dep?.operators ?? null,
			destinations: dep?.destinations ?? null,
		};
	});

	await Promise.all(
		rows.map((row) =>
			db
				.insert(lineDailyStats)
				.values({
					line: row.line,
					date,
					total: row.total,
					cancelled: row.cancelled,
					ghost: row.ghost,
					delayed: row.delayed,
					avgDelay: row.avgDelay,
					category: row.category,
					operators: row.operators,
					destinations: row.destinations,
				})
				.onConflictDoUpdate({
					target: [lineDailyStats.line, lineDailyStats.date],
					set: {
						total: row.total,
						cancelled: row.cancelled,
						ghost: row.ghost,
						delayed: row.delayed,
						avgDelay: row.avgDelay,
						category: row.category,
						operators: row.operators,
						destinations: row.destinations,
					},
				}),
		),
	);
}

async function materializeKnownStops(db: Db): Promise<void> {
	const rows = await db
		.select({
			stopId: journeyStops.stopId,
			stopName: sql<string>`MIN(${journeyStops.stopName})`.as("stop_name"),
			journeyCount:
				sql<number>`COUNT(DISTINCT ${journeyStops.journeyRef} || '|' || ${journeyStops.dayOfOperation})`.as(
					"journey_count",
				),
			cancelled: sql<number>`SUM(${journeyStops.cancelled})`.as("cancelled"),
			lines:
				sql<string>`(SELECT GROUP_CONCAT(DISTINCT ${journeyRuns.line}) FROM ${journeyRuns} WHERE ${journeyRuns.journeyRef} = ${journeyStops.journeyRef} AND ${journeyRuns.dayOfOperation} = ${journeyStops.dayOfOperation})`.as(
					"lines",
				),
			categories:
				sql<string>`(SELECT GROUP_CONCAT(DISTINCT ${journeyRuns.category}) FROM ${journeyRuns} WHERE ${journeyRuns.journeyRef} = ${journeyStops.journeyRef} AND ${journeyRuns.dayOfOperation} = ${journeyStops.dayOfOperation})`.as(
					"categories",
				),
		})
		.from(journeyStops)
		.where(sql`${journeyStops.dayOfOperation} >= date('now', '-7 days')`)
		.groupBy(journeyStops.stopId);

	if (rows.length === 0) return;

	const now = new Date().toISOString();
	const D1_MAX_PARAMS = 100;
	const colCount = Object.keys(getTableColumns(knownStops)).length;
	const batchSize = Math.max(1, Math.floor(D1_MAX_PARAMS / colCount));

	for (let i = 0; i < rows.length; i += batchSize) {
		const batch = rows.slice(i, i + batchSize);
		await db
			.insert(knownStops)
			.values(
				batch.map((r) => ({
					stopId: r.stopId,
					stopName: r.stopName,
					lines: r.lines,
					categories: r.categories,
					journeyCount: r.journeyCount,
					cancelled: r.cancelled,
					updatedAt: now,
				})),
			)
			.onConflictDoUpdate({
				target: knownStops.stopId,
				set: {
					stopName: excluded(knownStops.stopName),
					lines: excluded(knownStops.lines),
					categories: excluded(knownStops.categories),
					journeyCount: excluded(knownStops.journeyCount),
					cancelled: excluded(knownStops.cancelled),
					updatedAt: excluded(knownStops.updatedAt),
				},
			});
	}
}

function pickKey(apiKeys: string): string {
	const keys = apiKeys
		.split(",")
		.map((k) => k.trim())
		.filter(Boolean);
	return keys[Math.floor(Math.random() * keys.length)];
}

export interface CollectionResult {
	summary: Record<string, number>;
	linesToday: string[];
	operatorsToday: string[];
}

export async function runCollection(
	db: Db,
	ai: Ai,
	apiKeys: string,
	queue: Queue<JourneyPollMessage>,
	telegramToken?: string,
): Promise<CollectionResult> {
	const summary: Record<string, number> = {};
	const results = await Promise.all(
		STATIONS.map((station) =>
			collectDepartures(db, pickKey(apiKeys), station).then((count) => ({
				station,
				count,
			})),
		),
	);
	for (const { station, count } of results) {
		summary[station.slug] = count;
		console.log(`${station.slug}: upserted ${count} departures`);
	}

	await generateDailyHaiku(db, ai);

	const today = todayBerlin();

	await syncAllJourneyRuns(db, today);

	await markGhosts(db, today);

	const enqueued = await enqueueJourneys(db, queue, today);
	if (enqueued > 0) console.log(`enqueued ${enqueued} journeys for polling`);

	await Promise.all([
		materializeStationStats(db, today),
		materializeOperatorStats(db, today),
		materializeLineStats(db, today),
		materializeKnownStops(db),
	]);

	const [lineRows, operatorRows] = await Promise.all([
		db
			.select({ line: lineDailyStats.line })
			.from(lineDailyStats)
			.where(eq(lineDailyStats.date, today)),
		db
			.select({ operator: operatorDailyStats.operator })
			.from(operatorDailyStats)
			.where(eq(operatorDailyStats.date, today)),
	]);
	const linesToday = lineRows.map((r) => r.line);
	const operatorsToday = operatorRows.map((r) => r.operator);

	if (telegramToken) {
		try {
			const recentIssues = await db
				.select({
					id: departures.id,
					line: departures.line,
					direction: departures.direction,
					time: departures.time,
					cancelled: departures.cancelled,
					rtDate: departures.rtDate,
					rtTime: departures.rtTime,
					date: departures.date,
					stop: departures.stop,
					journeyNum: departures.journeyNum,
				})
				.from(departures)
				.where(
					and(
						eq(departures.date, today),
						eq(departures.notified, 0),
						or(
							eq(departures.cancelled, 1),
							sql`CASE WHEN ${departures.rtTime} IS NOT NULL AND ${departures.rtDate} IS NOT NULL THEN (strftime('%s', ${departures.rtDate} || ' ' || ${departures.rtTime}) - strftime('%s', ${departures.date} || ' ' || ${departures.time})) / 60.0 ELSE 0 END >= ${DELAY_THRESHOLD_MIN}`,
						),
					),
				)
				.orderBy(departures.time);

			if (recentIssues.length > 0) {
				const seen = new Set<string>();
				const unique = [...recentIssues]
					.sort((a, b) => {
						const scoreA = a.cancelled
							? Infinity
							: a.rtTime && a.rtDate
								? Math.abs(delayMinutes(a.date, a.time, a.rtDate, a.rtTime))
								: 0;
						const scoreB = b.cancelled
							? Infinity
							: b.rtTime && b.rtDate
								? Math.abs(delayMinutes(b.date, b.time, b.rtDate, b.rtTime))
								: 0;
						return scoreB - scoreA;
					})
					.filter((d) => {
						const key = `${d.date}|${d.time}|${d.line}|${d.direction}|${d.journeyNum}`;
						if (seen.has(key)) return false;
						seen.add(key);
						return true;
					});

				const { notifySubscribers } = await import("./telegram");
				await notifySubscribers(
					db,
					telegramToken,
					unique.map((d) => ({
						line: d.line,
						direction: d.direction,
						time: d.time,
						stop: d.stop ?? "",
						cancelled: !!d.cancelled,
						delayMin:
							d.rtTime && d.rtDate
								? Math.round(delayMinutes(d.date, d.time, d.rtDate, d.rtTime))
								: null,
					})),
				);

				const ids = recentIssues.map((d) => d.id);
				await db
					.update(departures)
					.set({ notified: 1 })
					.where(
						sql`${departures.id} IN (${sql.join(
							ids.map((id) => sql`${id}`),
							sql`,`,
						)})`,
					);
			}
		} catch (e) {
			console.error("Telegram notification failed:", e);
		}
	}

	return { summary, linesToday, operatorsToday };
}

async function syncAllJourneyRuns(db: Db, today: string): Promise<void> {
	const journeyAgg = await db
		.select({
			journeyRef: departures.journeyRef,
			line: sql<string>`MIN(${departures.line})`.as("line"),
			category: sql<string | null>`MIN(${departures.category})`.as("category"),
			operator: sql<string | null>`MIN(${departures.operator})`.as("operator"),
			direction: sql<string>`MIN(${departures.direction})`.as("direction"),
			stationId: sql<string>`MIN(${departures.stationId})`.as("station_id"),
			stop: sql<string | null>`MIN(${departures.stop})`.as("stop"),
			time: sql<string>`MIN(${departures.time})`.as("time"),
			journeyStatus: sql<string | null>`MAX(${departures.journeyStatus})`.as(
				"journey_status",
			),
			cancelledCount: sql<number>`SUM(${departures.cancelled})`.as(
				"cancelled_count",
			),
			depCount: count().as("dep_count"),
			trackedCount:
				sql<number>`SUM(CASE WHEN ${departures.rtTime} IS NOT NULL THEN 1 ELSE 0 END)`.as(
					"tracked_count",
				),
		})
		.from(departures)
		.where(and(eq(departures.date, today), isNotNull(departures.journeyRef)))
		.groupBy(departures.journeyRef);

	if (journeyAgg.length === 0) return;

	const snapshotAt = new Date().toISOString();
	const D1_MAX_PARAMS = 100;
	const colCount = Object.keys(getTableColumns(journeyRuns)).length;
	const batchSize = Math.max(1, Math.floor(D1_MAX_PARAMS / colCount));

	for (let i = 0; i < journeyAgg.length; i += batchSize) {
		const batch = journeyAgg.slice(i, i + batchSize);
		await db
			.insert(journeyRuns)
			.values(
				batch.map((a) => ({
					journeyRef: a.journeyRef!,
					dayOfOperation: today,
					line: a.line,
					category: a.category ?? null,
					operator: a.operator ?? null,
					lineId: null,
					originStopId: a.stationId,
					originName: a.stop ?? a.stationId,
					originDepTime: a.time,
					destStopId: "",
					destName: a.direction,
					destArrTime: a.time,
					status: a.journeyStatus ?? "P",
					cancelled: a.depCount > 0 && a.cancelledCount === a.depCount ? 1 : 0,
					partCancelled: a.cancelledCount > 0 ? 1 : 0,
					cancelledStopCount: a.cancelledCount,
					totalStopCount: 0,
					wasTracked: a.trackedCount > 0 ? 1 : 0,
					snapshotAt,
				})),
			)
			.onConflictDoUpdate({
				target: [journeyRuns.journeyRef, journeyRuns.dayOfOperation],
				set: {
					wasTracked: sql`MAX(${journeyRuns.wasTracked}, ${excluded(journeyRuns.wasTracked)})`,
					cancelled: excluded(journeyRuns.cancelled),
					partCancelled: sql`MAX(${journeyRuns.partCancelled}, ${excluded(journeyRuns.partCancelled)})`,
					cancelledStopCount: sql`MAX(${journeyRuns.cancelledStopCount}, ${excluded(journeyRuns.cancelledStopCount)})`,
					snapshotAt: excluded(journeyRuns.snapshotAt),
				},
			});
	}
}

async function markGhosts(db: Db, today: string): Promise<void> {
	const cutoff = nowBerlin().subtract(15, "minute").format("HH:mm");

	// Clear ghost for departures whose journey is actually tracked
	await db
		.update(departures)
		.set({ ghost: 0 })
		.where(
			and(
				eq(departures.date, today),
				eq(departures.ghost, 1),
				sql`${departures.journeyRef} IN (
					SELECT ${journeyRuns.journeyRef} FROM ${journeyRuns}
					WHERE ${journeyRuns.dayOfOperation} = ${today}
					AND ${journeyRuns.wasTracked} = 1
				)`,
			),
		);

	// Mark ghost for untracked, non-cancelled departures past cutoff
	await db
		.update(departures)
		.set({ ghost: 1 })
		.where(
			and(
				eq(departures.date, today),
				eq(departures.cancelled, 0),
				eq(departures.ghost, 0),
				sql`${departures.time} < ${cutoff}`,
				sql`(
					${departures.journeyRef} IS NULL
					OR ${departures.journeyRef} IN (
						SELECT ${journeyRuns.journeyRef} FROM ${journeyRuns}
						WHERE ${journeyRuns.dayOfOperation} = ${today}
						AND ${journeyRuns.wasTracked} = 0
						AND ${journeyRuns.cancelled} = 0
					)
				)`,
			),
		);
}

async function enqueueJourneys(
	db: Db,
	queue: Queue<JourneyPollMessage>,
	today: string,
): Promise<number> {
	const candidates = await db
		.select({
			journeyRef: journeyRuns.journeyRef,
			dayOfOperation: journeyRuns.dayOfOperation,
		})
		.from(journeyRuns)
		.where(
			and(
				eq(journeyRuns.dayOfOperation, today),
				sql`${journeyRuns.pollState} IS NULL`,
			),
		);

	if (candidates.length === 0) return 0;

	const refs = candidates.map((c) => c.journeyRef);
	for (let i = 0; i < refs.length; i += 50) {
		const batch = refs.slice(i, i + 50);
		await db
			.update(journeyRuns)
			.set({ pollState: "queued" })
			.where(
				and(
					eq(journeyRuns.dayOfOperation, today),
					sql`${journeyRuns.pollState} IS NULL`,
					sql`${journeyRuns.journeyRef} IN (${sql.join(
						batch.map((r) => sql`${r}`),
						sql`,`,
					)})`,
				),
			);
	}

	const QUEUE_BATCH_LIMIT = 100;
	const STAGGER_WINDOW_S = 5400;
	for (let i = 0; i < candidates.length; i += QUEUE_BATCH_LIMIT) {
		const batch = candidates.slice(i, i + QUEUE_BATCH_LIMIT);
		await queue.sendBatch(
			batch.map((c, j) => ({
				body: {
					journeyRef: c.journeyRef,
					dayOfOperation: c.dayOfOperation,
					pollCount: 0,
				},
				delaySeconds: Math.floor(
					((i + j) / candidates.length) * STAGGER_WINDOW_S,
				),
			})),
		);
	}

	return candidates.length;
}

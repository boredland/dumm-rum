import { and, count, eq, isNotNull, or, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { coalesce, excluded, max } from "../db/helpers";
import {
	departures,
	haikus,
	operatorDailyStats,
	stationDailyStats,
} from "../db/schema";
import { createHafasClient } from "./hafas";
import type { components } from "./hafas-types";
import {
	avgDelaySql,
	cancelledDistinctSql,
	delayedDistinctSql,
	delayedSql,
	totalDistinctSql,
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
	const start = nowBerlin().subtract(30, "minute");

	const { data, error } = await client.GET("/departureBoard", {
		params: {
			query: {
				type: "DEP",
				id: station.id,
				date: start.format("YYYY-MM-DD"),
				time: start.format("HH:mm"),
				duration: 45,
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
	const BATCH_SIZE = 3;

	for (let i = 0; i < deps.length; i += BATCH_SIZE) {
		const batch = deps.slice(i, i + BATCH_SIZE);
		try {
			await db
				.insert(departures)
				.values(
					batch.map((dep: Departure) => {
						const p = dep.ProductAtStop!;
						return {
							stationId: station.id,
							date: dep.date,
							time: dep.time,
							rtDate: dep.rtDate ?? null,
							rtTime: dep.rtTime ?? null,
							line: p.line!,
							direction: dep.direction ?? "",
							journeyStatus: dep.JourneyStatus ?? "P",
							cancelled: dep.cancelled ? 1 : 0,
							operator: p.operator ?? null,
							category: p.catOut ?? null,
							journeyNum: p.num!,
							reachable: dep.reachable ? 1 : 0,
							stop: dep.stop ?? null,
							stopExtId: dep.stopExtId ?? null,
							fetchedAt: now,
						};
					}),
				)
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
						journeyStatus: excluded(departures.journeyStatus),
						cancelled: max(
							departures.cancelled,
							excluded(departures.cancelled),
						),
						reachable: sql`CASE WHEN ${excluded(departures.cancelled)} THEN 0 ELSE ${excluded(departures.reachable)} END`,
						notified: sql`CASE WHEN ${departures.notified} = 1 AND (
							${excluded(departures.cancelled)} != ${departures.cancelled}
							OR ABS(
								COALESCE((strftime('%s', ${coalesce(excluded(departures.rtDate), sql`''`)} || ' ' || ${coalesce(excluded(departures.rtTime), sql`''`)}) - strftime('%s', ${departures.date} || ' ' || ${departures.time})) / 60.0, 0)
								- COALESCE((strftime('%s', ${coalesce(departures.rtDate, sql`''`)} || ' ' || ${coalesce(departures.rtTime, sql`''`)}) - strftime('%s', ${departures.date} || ' ' || ${departures.time})) / 60.0, 0)
							) >= 5
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
			delayed: delayedSql.as("delayed"),
			avgDelay: avgDelaySql.as("avg_delay"),
		})
		.from(departures)
		.where(eq(departures.date, date))
		.groupBy(departures.stationId);

	for (const row of rows) {
		await db
			.insert(stationDailyStats)
			.values({
				stationId: row.stationId,
				date,
				total: row.total,
				cancelled: row.cancelled,
				delayed: row.delayed,
				avgDelay: row.avgDelay,
			})
			.onConflictDoUpdate({
				target: [stationDailyStats.stationId, stationDailyStats.date],
				set: {
					total: row.total,
					cancelled: row.cancelled,
					delayed: row.delayed,
					avgDelay: row.avgDelay,
				},
			});
	}
}

async function materializeOperatorStats(db: Db, date: string): Promise<void> {
	const rows = await db
		.select({
			operator: departures.operator,
			total: totalDistinctSql.as("total"),
			cancelled: cancelledDistinctSql.as("cancelled"),
			delayed: delayedDistinctSql.as("delayed"),
			avgDelay: avgDelaySql.as("avg_delay"),
		})
		.from(departures)
		.where(and(eq(departures.date, date), isNotNull(departures.operator)))
		.groupBy(departures.operator);

	for (const row of rows) {
		await db
			.insert(operatorDailyStats)
			.values({
				operator: row.operator!,
				date,
				total: row.total,
				cancelled: row.cancelled,
				delayed: row.delayed,
				avgDelay: row.avgDelay,
			})
			.onConflictDoUpdate({
				target: [operatorDailyStats.operator, operatorDailyStats.date],
				set: {
					total: row.total,
					cancelled: row.cancelled,
					delayed: row.delayed,
					avgDelay: row.avgDelay,
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

export async function runCollection(
	db: Db,
	ai: Ai,
	apiKeys: string,
	telegramToken?: string,
): Promise<Record<string, number>> {
	const now = nowBerlin();
	const slot = Math.floor((now.hour() * 60 + now.minute()) / 3);
	const idx = (slot * 3) % STATIONS.length;
	const batch = [0, 1, 2].map((i) => STATIONS[(idx + i) % STATIONS.length]);

	const summary: Record<string, number> = {};
	const results = await Promise.all(
		batch.map((station) =>
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
	await Promise.all([
		materializeStationStats(db, today),
		materializeOperatorStats(db, today),
	]);

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

	return summary;
}

import { and, count, eq, isNotNull, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { d1BatchSize, excluded } from "../db/helpers";
import {
	haikus,
	journeyRuns,
	journeyStops,
	knownStops,
	lineDailyStats,
	operatorDailyStats,
} from "../db/schema";
import { createHafasClient } from "./hafas";
import type { components } from "./hafas-types";
import { ghostCaseSql } from "./queries";
import type { Station } from "./stations";
import { nameToSlug, STATIONS } from "./stations";
import {
	DELAY_THRESHOLD_MIN,
	nowBerlin,
	PLANNED_FREQUENCY_MIN,
	pickKey,
	todayBerlin,
} from "./utils";

type Departure = components["schemas"]["Departure"];

const EXCLUDE_CATEGORIES = new Set(["ICE", "IC", "EC"]);

async function discoverJourneys(
	db: Db,
	apiKey: string,
	station: Station,
	today: string,
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
			d.JourneyDetailRef?.ref &&
			!EXCLUDE_CATEGORIES.has(d.ProductAtStop?.catOut ?? "") &&
			!stationExcludes?.has(d.ProductAtStop?.catOut ?? "") &&
			!/N$/.test(d.ProductAtStop?.line ?? ""),
	);
	if (deps.length === 0) return 0;

	const snapshotAt = new Date().toISOString();
	const seen = new Set<string>();
	const rows: {
		journeyRef: string;
		dayOfOperation: string;
		line: string;
		category: string | null;
		operator: string | null;
		originStopId: string;
		originName: string;
		originDepTime: string;
		destStopId: string;
		destName: string;
		destArrTime: string;
		status: string;
		cancelled: number;
		totalStopCount: number;
		snapshotAt: string;
	}[] = [];

	for (const dep of deps) {
		const ref = dep.JourneyDetailRef!.ref!;
		if (seen.has(ref)) continue;
		seen.add(ref);
		const p = dep.ProductAtStop!;
		rows.push({
			journeyRef: ref,
			dayOfOperation: dep.date ?? today,
			line: p.line!,
			category: p.catOut ?? null,
			operator: p.operator ?? null,
			originStopId: station.id,
			originName: dep.stop ?? station.id,
			originDepTime: dep.time,
			destStopId: "",
			destName: dep.direction ?? "",
			destArrTime: dep.time,
			status: dep.JourneyStatus ?? "P",
			cancelled: dep.cancelled ? 1 : 0,
			totalStopCount: 0,
			snapshotAt,
		});
	}

	const batchSize = d1BatchSize(journeyRuns);

	for (let i = 0; i < rows.length; i += batchSize) {
		const batch = rows.slice(i, i + batchSize);
		await db.insert(journeyRuns).values(batch).onConflictDoNothing();
	}

	return rows.length;
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
			category: journeyRuns.category,
			cancelled: sql<number>`SUM(${journeyRuns.cancelled})`.as("cancelled"),
		})
		.from(journeyRuns)
		.where(
			and(
				eq(journeyRuns.dayOfOperation, yesterday),
				isNotNull(journeyRuns.category),
			),
		)
		.groupBy(journeyRuns.category)
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

async function materializeOperatorStats(db: Db, date: string): Promise<void> {
	const rows = await db
		.select({
			operator: journeyRuns.operator,
			total: count().as("total"),
			cancelled: sql<number>`SUM(${journeyRuns.cancelled})`.as("cancelled"),
			ghost: sql<number>`SUM(${ghostCaseSql})`.as("ghost"),
			delayed:
				sql<number>`SUM(CASE WHEN ${journeyRuns.cancelled} = 0 AND EXISTS (
					SELECT 1 FROM journey_stops js
					WHERE js.journey_ref = "journey_runs"."journey_ref"
					AND js.day_of_operation = "journey_runs"."day_of_operation"
					AND js.rt_dep_time IS NOT NULL AND js.dep_time IS NOT NULL
					AND (strftime('%s', js.day_of_operation || 'T' || js.rt_dep_time) - strftime('%s', js.day_of_operation || 'T' || js.dep_time)) / 60.0 >= ${DELAY_THRESHOLD_MIN}
				) THEN 1 ELSE 0 END)`.as("delayed"),
			avgDelay: sql<
				number | null
			>`AVG(CASE WHEN ${journeyRuns.cancelled} = 1 THEN ${PLANNED_FREQUENCY_MIN} ELSE (
					SELECT (strftime('%s', js.day_of_operation || 'T' || js.rt_dep_time) - strftime('%s', js.day_of_operation || 'T' || js.dep_time)) / 60.0
					FROM journey_stops js
					WHERE js.journey_ref = "journey_runs"."journey_ref"
					AND js.day_of_operation = "journey_runs"."day_of_operation"
					AND js.rt_dep_time IS NOT NULL AND js.dep_time IS NOT NULL
					AND js.route_idx = 0
				) END)`.as("avg_delay"),
		})
		.from(journeyRuns)
		.where(
			and(
				eq(journeyRuns.dayOfOperation, date),
				isNotNull(journeyRuns.operator),
			),
		)
		.groupBy(journeyRuns.operator);

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
	const rows = await db
		.select({
			line: journeyRuns.line,
			category: sql<string>`MAX(${journeyRuns.category})`.as("category"),
			total: count().as("total"),
			cancelled: sql<number>`SUM(${journeyRuns.cancelled})`.as("cancelled"),
			ghost: sql<number>`SUM(${ghostCaseSql})`.as("ghost"),
			delayed:
				sql<number>`SUM(CASE WHEN ${journeyRuns.cancelled} = 0 AND EXISTS (
					SELECT 1 FROM journey_stops js
					WHERE js.journey_ref = "journey_runs"."journey_ref"
					AND js.day_of_operation = "journey_runs"."day_of_operation"
					AND js.rt_dep_time IS NOT NULL AND js.dep_time IS NOT NULL
					AND (strftime('%s', js.day_of_operation || 'T' || js.rt_dep_time) - strftime('%s', js.day_of_operation || 'T' || js.dep_time)) / 60.0 >= ${DELAY_THRESHOLD_MIN}
				) THEN 1 ELSE 0 END)`.as("delayed"),
			avgDelay: sql<
				number | null
			>`AVG(CASE WHEN ${journeyRuns.cancelled} = 1 THEN ${PLANNED_FREQUENCY_MIN} ELSE (
					SELECT (strftime('%s', js.day_of_operation || 'T' || js.rt_dep_time) - strftime('%s', js.day_of_operation || 'T' || js.dep_time)) / 60.0
					FROM journey_stops js
					WHERE js.journey_ref = "journey_runs"."journey_ref"
					AND js.day_of_operation = "journey_runs"."day_of_operation"
					AND js.rt_dep_time IS NOT NULL AND js.dep_time IS NOT NULL
					AND js.route_idx = 0
				) END)`.as("avg_delay"),
			operators: sql<string>`GROUP_CONCAT(DISTINCT ${journeyRuns.operator})`.as(
				"operators",
			),
			destinations:
				sql<string>`GROUP_CONCAT(DISTINCT ${journeyRuns.destName})`.as(
					"destinations",
				),
		})
		.from(journeyRuns)
		.where(eq(journeyRuns.dayOfOperation, date))
		.groupBy(journeyRuns.line);

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
			ghost: sql<number>`SUM(${ghostCaseSql})`.as("ghost"),
			delayed:
				sql<number>`SUM(CASE WHEN ${journeyStops.cancelled} = 0 AND ${journeyStops.rtDepTime} IS NOT NULL AND ${journeyStops.depTime} IS NOT NULL AND (strftime('%s', ${journeyStops.dayOfOperation} || 'T' || ${journeyStops.rtDepTime}) - strftime('%s', ${journeyStops.dayOfOperation} || 'T' || ${journeyStops.depTime})) / 60.0 >= ${DELAY_THRESHOLD_MIN} THEN 1 ELSE 0 END)`.as(
					"delayed",
				),
			lines: sql<string>`GROUP_CONCAT(DISTINCT ${journeyRuns.line})`.as(
				"lines",
			),
			categories:
				sql<string>`GROUP_CONCAT(DISTINCT ${journeyRuns.category})`.as(
					"categories",
				),
		})
		.from(journeyStops)
		.leftJoin(
			journeyRuns,
			and(
				eq(journeyRuns.journeyRef, journeyStops.journeyRef),
				eq(journeyRuns.dayOfOperation, journeyStops.dayOfOperation),
			),
		)
		.where(sql`${journeyStops.dayOfOperation} >= date('now', '-7 days')`)
		.groupBy(journeyStops.stopId);

	if (rows.length === 0) return;

	const now = new Date().toISOString();
	const batchSize = d1BatchSize(knownStops);

	for (let i = 0; i < rows.length; i += batchSize) {
		const batch = rows.slice(i, i + batchSize);
		await db
			.insert(knownStops)
			.values(
				batch.map((r) => ({
					stopId: r.stopId,
					stopName: r.stopName,
					slug: nameToSlug(r.stopName),
					lines: r.lines,
					categories: r.categories,
					journeyCount: r.journeyCount,
					cancelled: r.cancelled,
					ghost: r.ghost,
					delayed: r.delayed,
					updatedAt: now,
				})),
			)
			.onConflictDoUpdate({
				target: knownStops.stopId,
				set: {
					stopName: excluded(knownStops.stopName),
					slug: excluded(knownStops.slug),
					lines: excluded(knownStops.lines),
					categories: excluded(knownStops.categories),
					journeyCount: excluded(knownStops.journeyCount),
					cancelled: excluded(knownStops.cancelled),
					ghost: excluded(knownStops.ghost),
					delayed: excluded(knownStops.delayed),
					updatedAt: excluded(knownStops.updatedAt),
				},
			});
	}
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
): Promise<CollectionResult> {
	const today = todayBerlin();
	const summary: Record<string, number> = {};
	const results = await Promise.all(
		STATIONS.map((station) =>
			discoverJourneys(db, pickKey(apiKeys), station, today).then((count) => ({
				station,
				count,
			})),
		),
	);
	for (const { station, count } of results) {
		summary[station.slug] = count;
		console.log(`${station.slug}: discovered ${count} journeys`);
	}

	await generateDailyHaiku(db, ai);

	const enqueued = await enqueueJourneys(db, queue, today);
	if (enqueued > 0) console.log(`enqueued ${enqueued} journeys for polling`);

	await Promise.all([
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

	return {
		summary,
		linesToday: lineRows.map((r) => r.line),
		operatorsToday: operatorRows.map((r) => r.operator),
	};
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

	await db
		.update(journeyRuns)
		.set({ pollState: "queued" })
		.where(
			and(
				eq(journeyRuns.dayOfOperation, today),
				sql`${journeyRuns.pollState} IS NULL`,
			),
		);

	const QUEUE_BATCH_LIMIT = 100;
	const STAGGER_WINDOW_S = 60;
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

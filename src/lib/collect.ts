import { createHafasClient } from "./hafas";
import type { components } from "./hafas-types";
import type { Station } from "./stations";
import { STATIONS } from "./stations";
import { nowBerlin, todayBerlin } from "./utils";

type Departure = components["schemas"]["Departure"];

const UPSERT_SQL = `
INSERT INTO departures (station_id, date, time, rt_date, rt_time, line, direction, journey_status, cancelled, operator, category, journey_num, reachable, stop, stop_ext_id, fetched_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(station_id, date, time, line, direction, journey_num)
DO UPDATE SET
  rt_date = COALESCE(excluded.rt_date, departures.rt_date),
  rt_time = COALESCE(excluded.rt_time, departures.rt_time),
  journey_status = excluded.journey_status,
  cancelled = MAX(departures.cancelled, excluded.cancelled),
  reachable = CASE WHEN excluded.cancelled THEN 0 ELSE excluded.reachable END,
  fetched_at = excluded.fetched_at`;

async function collectDepartures(
	db: D1Database,
	apiKey: string,
	station: Station,
): Promise<number> {
	const client = createHafasClient(apiKey);
	const oneHourAgo = nowBerlin().subtract(1, "hour");

	const { data, error } = await client.GET("/departureBoard", {
		params: {
			query: {
				type: "DEP",
				id: station.id,
				date: oneHourAgo.format("YYYY-MM-DD"),
				time: oneHourAgo.format("HH:mm"),
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

	const departures = (data.Departure ?? []).filter(
		(d: Departure) => d.ProductAtStop?.line && d.ProductAtStop?.num,
	);
	if (departures.length === 0) return 0;

	const now = new Date().toISOString();
	const BATCH_SIZE = 50;

	for (let i = 0; i < departures.length; i += BATCH_SIZE) {
		const stmts = departures.slice(i, i + BATCH_SIZE).map((dep: Departure) => {
			const p = dep.ProductAtStop!;
			return db
				.prepare(UPSERT_SQL)
				.bind(
					station.id,
					dep.date,
					dep.time,
					dep.rtDate ?? null,
					dep.rtTime ?? null,
					p.line,
					dep.direction ?? null,
					dep.JourneyStatus ?? "P",
					dep.cancelled ? 1 : 0,
					p.operator,
					p.catOut,
					p.num,
					dep.reachable ? 1 : 0,
					dep.stop ?? null,
					dep.stopExtId ?? null,
					now,
				);
		});
		await db.batch(stmts);
	}

	return departures.length;
}

async function generateDailyHaiku(
	db: D1Database,
	ai: Ai,
	station: Station,
): Promise<void> {
	const today = todayBerlin();
	const existing = await db
		.prepare("SELECT 1 FROM haikus WHERE date = ? AND station_id = ?")
		.bind(today, station.id)
		.first();
	if (existing) return;

	const vehicle =
		station.type === "tram"
			? "tram"
			: station.type === "underground"
				? "U-Bahn train"
				: "bus";
	const response = await ai.run("@cf/ibm-granite/granite-4.0-h-micro", {
		messages: [
			{
				role: "system",
				content:
					"You write haikus (5-7-5 syllables). Respond with ONLY the haiku, nothing else. No quotes, no explanation, no title.",
			},
			{
				role: "user",
				content: `Write a haiku about waiting at a ${vehicle} stop, not knowing if the ${vehicle} was cancelled or if it ever existed. Theme: missing ${vehicle}s, uncertainty, urban melancholy.`,
			},
		],
		max_tokens: 100,
	});

	const result = response as Record<string, unknown>;
	const haiku = (
		(result.response as string) ??
		(result.choices as { message: { content: string } }[])?.[0]?.message
			?.content
	)?.trim();
	if (!haiku) {
		console.error("Haiku generation returned empty response", response);
		return;
	}
	console.log(`Generated haiku for ${station.slug}: ${haiku}`);

	await db
		.prepare(
			"INSERT INTO haikus (date, station_id, haiku) VALUES (?, ?, ?) ON CONFLICT(date, station_id) DO NOTHING",
		)
		.bind(today, station.id, haiku)
		.run();
}

export async function runCollection(
	db: D1Database,
	ai: Ai,
	apiKey: string,
): Promise<Record<string, number>> {
	const results = await Promise.all(
		STATIONS.flatMap((s) => [
			collectDepartures(db, apiKey, s),
			generateDailyHaiku(db, ai, s),
		]),
	);
	const counts = results.filter((_, i) => i % 2 === 0) as number[];
	const summary: Record<string, number> = {};
	for (let i = 0; i < STATIONS.length; i++) {
		summary[STATIONS[i].slug] = counts[i];
		console.log(`${STATIONS[i].slug}: upserted ${counts[i]} departures`);
	}
	return summary;
}

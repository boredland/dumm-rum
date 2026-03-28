import { and, count, eq, isNotNull, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import {
	departures,
	haikus,
	operatorDailyStats,
	stationDailyStats,
} from "../db/schema";
import { createHafasClient } from "./hafas";
import type { components } from "./hafas-types";
import type { Station } from "./stations";
import { STATIONS } from "./stations";
import { nowBerlin, timeToMinutes, todayBerlin } from "./utils";

type Departure = components["schemas"]["Departure"];

async function collectDepartures(
	db: Db,
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

	const deps = (data.Departure ?? []).filter(
		(d: Departure) => d.ProductAtStop?.line && d.ProductAtStop?.num,
	);
	if (deps.length === 0) return 0;

	const now = new Date().toISOString();
	const BATCH_SIZE = 5;

	for (let i = 0; i < deps.length; i += BATCH_SIZE) {
		const batch = deps.slice(i, i + BATCH_SIZE);
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
					rtDate: sql`COALESCE(excluded.rt_date, ${departures.rtDate})`,
					rtTime: sql`COALESCE(excluded.rt_time, ${departures.rtTime})`,
					journeyStatus: sql`excluded.journey_status`,
					cancelled: sql`MAX(${departures.cancelled}, excluded.cancelled)`,
					reachable: sql`CASE WHEN excluded.cancelled THEN 0 ELSE excluded.reachable END`,
					fetchedAt: sql`excluded.fetched_at`,
				},
			});
	}

	return deps.length;
}

async function generateDailyHaiku(
	db: Db,
	ai: Ai,
	station: Station,
): Promise<void> {
	const today = todayBerlin();
	const existing = await db
		.select({ date: haikus.date })
		.from(haikus)
		.where(and(eq(haikus.date, today), eq(haikus.stationId, station.id)))
		.limit(1);
	if (existing.length > 0) return;

	const response = await ai.run("@cf/ibm-granite/granite-4.0-h-micro", {
		messages: [
			{
				role: "system",
				content:
					"You write haikus (5-7-5 syllables). Respond with ONLY the haiku, nothing else. No quotes, no explanation, no title.",
			},
			{
				role: "user",
				content:
					"Write a haiku about waiting at a bus stop, not knowing if the bus was cancelled or if it ever existed. Theme: missing buses, uncertainty, urban melancholy.",
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
		.insert(haikus)
		.values({ date: today, stationId: station.id, haiku })
		.onConflictDoNothing();
}

async function materializeStationStats(db: Db, date: string): Promise<void> {
	const rows = await db
		.select({
			stationId: departures.stationId,
			direction: departures.direction,
			total: count().as("total"),
			cancelled: sql<number>`SUM(${departures.cancelled})`.as("cancelled"),
			avgDelay: sql<
				number | null
			>`AVG(CASE WHEN ${departures.cancelled} = 0 AND ${departures.rtTime} IS NOT NULL THEN (strftime('%s', ${departures.rtTime}) - strftime('%s', ${departures.time})) / 60.0 END)`.as(
				"avg_delay",
			),
			rtCount:
				sql<number>`SUM(CASE WHEN ${departures.cancelled} = 0 AND ${departures.rtTime} IS NOT NULL THEN 1 ELSE 0 END)`.as(
					"rt_count",
				),
			firstTime: sql<string>`MIN(${departures.time})`.as("first_time"),
			lastTime: sql<string>`MAX(${departures.time})`.as("last_time"),
		})
		.from(departures)
		.where(eq(departures.date, date))
		.groupBy(departures.stationId, departures.direction);

	const stationMap = new Map<
		string,
		{
			total: number;
			cancelled: number;
			delaySum: number;
			delayCount: number;
			freqs: number[];
			actualFreqs: number[];
		}
	>();
	for (const row of rows) {
		const entry = stationMap.get(row.stationId) ?? {
			total: 0,
			cancelled: 0,
			delaySum: 0,
			delayCount: 0,
			freqs: [],
			actualFreqs: [],
		};
		entry.total += row.total;
		entry.cancelled += row.cancelled;

		const span = timeToMinutes(row.lastTime) - timeToMinutes(row.firstTime);
		if (span > 0 && row.total > 1) {
			const freq = span / (row.total - 1);
			entry.freqs.push(freq);
			const uncancelled = row.total - row.cancelled;
			if (uncancelled > 1) entry.actualFreqs.push(span / (uncancelled - 1));

			if (row.rtCount > 0 || row.cancelled > 0) {
				const rtDelay = (row.avgDelay ?? 0) * row.rtCount;
				const cancelDelay = row.cancelled * freq;
				const totalWithData = row.rtCount + row.cancelled;
				if (totalWithData > 0) {
					entry.delaySum +=
						((rtDelay + cancelDelay) / totalWithData) * row.total;
					entry.delayCount += row.total;
				}
			}
		}
		stationMap.set(row.stationId, entry);
	}

	for (const [stationId, s] of stationMap) {
		const avgDelay = s.delayCount > 0 ? s.delaySum / s.delayCount : null;
		const plannedFreq =
			s.freqs.length > 0
				? s.freqs.reduce((a, b) => a + b, 0) / s.freqs.length
				: null;
		const actualFreq =
			s.actualFreqs.length > 0
				? s.actualFreqs.reduce((a, b) => a + b, 0) / s.actualFreqs.length
				: null;
		await db
			.insert(stationDailyStats)
			.values({
				stationId,
				date,
				total: s.total,
				cancelled: s.cancelled,
				avgDelay,
				plannedFreq,
				actualFreq,
			})
			.onConflictDoUpdate({
				target: [stationDailyStats.stationId, stationDailyStats.date],
				set: {
					total: s.total,
					cancelled: s.cancelled,
					avgDelay,
					plannedFreq,
					actualFreq,
				},
			});
	}
}

async function materializeOperatorStats(db: Db, date: string): Promise<void> {
	const rows = await db
		.select({
			operator: departures.operator,
			total: count().as("total"),
			cancelled: sql<number>`SUM(${departures.cancelled})`.as("cancelled"),
			avgDelay: sql<
				number | null
			>`AVG(CASE WHEN ${departures.cancelled} = 0 AND ${departures.rtTime} IS NOT NULL THEN (strftime('%s', ${departures.rtTime}) - strftime('%s', ${departures.time})) / 60.0 END)`.as(
				"avg_delay",
			),
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
				avgDelay: row.avgDelay,
			})
			.onConflictDoUpdate({
				target: [operatorDailyStats.operator, operatorDailyStats.date],
				set: {
					total: row.total,
					cancelled: row.cancelled,
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
): Promise<Record<string, number>> {
	const summary: Record<string, number> = {};
	for (const s of STATIONS) {
		const count = await collectDepartures(db, pickKey(apiKeys), s);
		await generateDailyHaiku(db, ai, s);
		summary[s.slug] = count;
		console.log(`${s.slug}: upserted ${count} departures`);
	}

	const today = todayBerlin();
	await materializeStationStats(db, today);
	await materializeOperatorStats(db, today);

	return summary;
}

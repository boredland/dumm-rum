import { and, count, eq, isNotNull, sql } from "drizzle-orm";
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
import { avgDelaySql, delayedSql } from "./queries";
import type { Station } from "./stations";
import { STATIONS } from "./stations";
import { nowBerlin, todayBerlin } from "./utils";

type Departure = components["schemas"]["Departure"];

const EXCLUDE_CATEGORIES = new Set(["ICE", "IC", "EC"]);
const TEXT_NOTE_TYPES = new Set(["H", "M", "D", "Q", "L"]);

function extractMessages(dep: Departure): string | null {
	const msgs: string[] = [];
	if (dep.Messages?.Message) {
		for (const m of dep.Messages.Message) {
			const text = m.head || m.text || m.lead;
			if (text) msgs.push(text);
		}
	}
	if (dep.Notes?.Note) {
		for (const n of dep.Notes.Note) {
			if (n.value && n.type && TEXT_NOTE_TYPES.has(n.type)) msgs.push(n.value);
		}
	}
	return msgs.length > 0 ? JSON.stringify(msgs) : null;
}

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

	const deps = (data.Departure ?? []).filter(
		(d: Departure) =>
			d.ProductAtStop?.line &&
			d.ProductAtStop?.num &&
			!EXCLUDE_CATEGORIES.has(d.ProductAtStop?.catOut ?? ""),
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
							messages: extractMessages(dep),
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
						messages: coalesce(
							excluded(departures.messages),
							departures.messages,
						),
						fetchedAt: sql`CASE WHEN
							${coalesce(excluded(departures.rtDate), sql`''`)} != ${coalesce(departures.rtDate, sql`''`)}
							OR ${coalesce(excluded(departures.rtTime), sql`''`)} != ${coalesce(departures.rtTime, sql`''`)}
							OR ${excluded(departures.cancelled)} != ${departures.cancelled}
							OR ${coalesce(excluded(departures.messages), sql`''`)} != ${coalesce(departures.messages, sql`''`)}
							THEN ${excluded(departures.fetchedAt)} ELSE ${departures.fetchedAt} END`,
					},
				});
		} catch (e) {
			console.error(`Batch insert failed for ${station.slug}:`, e);
		}
	}

	return deps.length;
}

async function generateDailyHaiku(db: Db, ai: Ai): Promise<void> {
	const today = todayBerlin();
	const existing = await db
		.select({ date: haikus.date })
		.from(haikus)
		.where(eq(haikus.date, today))
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
	console.log(`Generated haiku: ${haiku}`);

	await db.insert(haikus).values({ date: today, haiku }).onConflictDoNothing();
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
			total: count().as("total"),
			cancelled: sql<number>`SUM(${departures.cancelled})`.as("cancelled"),
			delayed: delayedSql.as("delayed"),
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
	kv: KVNamespace,
): Promise<Record<string, number>> {
	const idx = Number((await kv.get("station_idx")) ?? "0");
	const batch = [0, 1].map((i) => STATIONS[(idx + i) % STATIONS.length]);
	await kv.put("station_idx", String((idx + 2) % STATIONS.length));

	const summary: Record<string, number> = {};
	for (const station of batch) {
		const count = await collectDepartures(db, pickKey(apiKeys), station);
		summary[station.slug] = count;
		console.log(`${station.slug}: upserted ${count} departures`);
	}

	await generateDailyHaiku(db, ai);

	const today = todayBerlin();
	const lastMat = (await kv.get("last_materialized")) ?? "";
	const changed = await db
		.select({ cnt: count() })
		.from(departures)
		.where(
			and(
				eq(departures.date, today),
				lastMat ? sql`${departures.fetchedAt} > ${lastMat}` : undefined,
			),
		);
	if (changed[0].cnt > 0) {
		await Promise.all([
			materializeStationStats(db, today),
			materializeOperatorStats(db, today),
		]);
		await kv.put("last_materialized", new Date().toISOString());
		console.log("Materialized stats");
	} else {
		console.log("Skipped materialization, no changes");
	}

	return summary;
}

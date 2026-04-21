/**
 * KVV discovery cron. Parallel-fans a DM request out to every
 * `KVV_STATIONS` entry — EFA is per-stop, no batch — inserts skeleton
 * rows into `journey_runs` keyed by a synthetic `kvv|...` tripRef, and
 * enqueues poll jobs for every new run. Mirrors the RMV `discover.ts`
 * pipeline, just with EFA JSON instead of HAFAS mgate.
 */

import { and, eq, sql } from "drizzle-orm";
import type PgBoss from "pg-boss";
import type { Db } from "../db/client.ts";
import { journeyRuns } from "../db/schema.ts";
import { type EfaStationBoardEntry, efaStationBoard } from "./kvv-efa.ts";
import { KVV_STATIONS } from "./kvv-stations.ts";
import type { Station } from "./stations.ts";
import { nowBerlin, todayBerlin } from "./utils.ts";

export const KVV_POLL_QUEUE = "kvv-poll";

async function discoverStopDepartures(
	db: Db,
	station: Station,
	departures: EfaStationBoardEntry[],
	today: string,
): Promise<number> {
	if (departures.length === 0) return 0;
	const snapshotAt = new Date().toISOString();
	const seen = new Set<string>();
	const rows: (typeof journeyRuns.$inferInsert)[] = [];

	for (const d of departures) {
		if (seen.has(d.tripRef)) continue;
		seen.add(d.tripRef);
		rows.push({
			journeyRef: d.tripRef,
			dayOfOperation: d.dayOfOperation || today,
			line: d.line,
			category: d.category,
			operator: d.operator,
			originStopId: station.id,
			originName: station.name,
			originDepTime: d.depTime,
			// Placeholder — poll fills the real dest via TripStopTimes.
			destStopId: "",
			destName: d.destName,
			destArrTime: d.depTime,
			cancelled: d.cancelled,
			snapshotAt,
		});
	}

	rows.sort(
		(a, b) =>
			a.journeyRef.localeCompare(b.journeyRef) ||
			a.dayOfOperation.localeCompare(b.dayOfOperation),
	);
	await db.insert(journeyRuns).values(rows).onConflictDoNothing();
	return rows.length;
}

async function enqueueNewKvvJourneys(
	db: Db,
	boss: PgBoss,
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
				sql`${journeyRuns.journeyRef} LIKE 'kvv|%'`,
			),
		);

	if (candidates.length === 0) return 0;

	// Claim first so overlapping discovery runs can't double-enqueue.
	await db
		.update(journeyRuns)
		.set({ pollState: "queued" })
		.where(
			and(
				eq(journeyRuns.dayOfOperation, today),
				sql`${journeyRuns.pollState} IS NULL`,
				sql`${journeyRuns.journeyRef} LIKE 'kvv|%'`,
			),
		);

	await boss.insert(
		candidates.map((c) => ({
			name: KVV_POLL_QUEUE,
			data: {
				journeyRef: c.journeyRef,
				dayOfOperation: c.dayOfOperation,
				pollCount: 0,
			},
		})),
	);

	return candidates.length;
}

export async function runKvvDiscovery(db: Db, boss: PgBoss): Promise<void> {
	const today = todayBerlin();
	const now = nowBerlin();
	const date = now.format("YYYYMMDD");
	const time = now.format("HHmm");

	// One HTTP per configured stop, run concurrently. Per-stop failures
	// don't take down the whole batch — each promise resolves to its own
	// `{ station, count }` slot.
	const perStation = await Promise.all(
		KVV_STATIONS.map(async (station) => {
			const r = await efaStationBoard(station.id, {
				date,
				time,
				limit: 40,
			});
			if (r.kind !== "ok") {
				console.error(
					`kvv stationBoard failed for ${station.slug}: ${r.errCode}`,
				);
				return { station, count: 0 };
			}
			const count = await discoverStopDepartures(
				db,
				station,
				r.departures,
				today,
			);
			return { station, count };
		}),
	);
	for (const { station, count } of perStation) {
		console.log(`kvv ${station.slug}: discovered ${count} journeys`);
	}

	const enqueued = await enqueueNewKvvJourneys(db, boss, today);
	if (enqueued > 0)
		console.log(`kvv enqueued ${enqueued} journeys for polling`);
}

import { and, eq, sql } from "drizzle-orm";
import type PgBoss from "pg-boss";
import type { Db } from "../db/client.ts";
import { journeyRuns } from "../db/schema.ts";
import {
	type MgateStationBoardEntry,
	mgateStationBoardBatch,
} from "./mgate.ts";
import { STATIONS, type Station } from "./stations.ts";
import { nowBerlin, todayBerlin } from "./utils.ts";

// Categories we never want in journey_runs. FLX / FlixTrain ride their
// own collection pipeline (src/lib/flix-proxy.ts fetches Flix's
// location feed directly) so letting them through here would just
// double-count. Long-distance trains (ICE / IC / EC / ECE / NJ / EN /
// RJ / RJX / TGV / EST) are kept because their delay + cancellation
// stats from HAFAS are valuable even though they aren't strictly ÖPNV —
// users asked for reliability data on the intercity services that run
// through Rhein-Main.
const EXCLUDE_CATEGORIES = new Set(["FLX", "FlixTrain"]);

const POLL_QUEUE = "journey-poll";

async function discoverStationJourneys(
	db: Db,
	station: Station,
	journeys: MgateStationBoardEntry[],
	today: string,
): Promise<number> {
	const stationExcludes = station.excludeCategories
		? new Set(station.excludeCategories)
		: null;
	const filtered = journeys.filter(
		(j) =>
			!EXCLUDE_CATEGORIES.has(j.category ?? "") &&
			!stationExcludes?.has(j.category ?? "") &&
			!/N$/.test(j.line),
	);
	if (filtered.length === 0) return 0;

	const snapshotAt = new Date().toISOString();
	const seen = new Set<string>();
	const rows: (typeof journeyRuns.$inferInsert)[] = [];

	for (const j of filtered) {
		if (seen.has(j.journeyRef)) continue;
		seen.add(j.journeyRef);
		rows.push({
			journeyRef: j.journeyRef,
			dayOfOperation: j.dayOfOperation || today,
			line: j.line,
			category: j.category,
			operator: j.operator,
			originStopId: station.id,
			originName: station.name,
			originDepTime: j.depTime,
			// Placeholder — the poller fills the real dest from JourneyDetails.
			destStopId: "",
			destName: j.destName,
			destArrTime: j.depTime,
			cancelled: j.cancelled,
			snapshotAt,
		});
	}

	await db.insert(journeyRuns).values(rows).onConflictDoNothing();
	return rows.length;
}

async function enqueueNewJourneys(
	db: Db,
	boss: PgBoss,
	today: string,
): Promise<number> {
	// KVV refs (prefixed `kvv|…`) share the same `journey_runs` table
	// but belong to a separate discover/poll pipeline; excluding them
	// here keeps the RMV poller from trying to interpret an EFA
	// `stateless:tripCode` as a HAFAS jid and burning its retry budget.
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
				sql`${journeyRuns.journeyRef} NOT LIKE 'kvv|%'`,
			),
		);

	if (candidates.length === 0) return 0;

	// Claim first so parallel discovery runs can't double-enqueue.
	await db
		.update(journeyRuns)
		.set({ pollState: "queued" })
		.where(
			and(
				eq(journeyRuns.dayOfOperation, today),
				sql`${journeyRuns.pollState} IS NULL`,
				sql`${journeyRuns.journeyRef} NOT LIKE 'kvv|%'`,
			),
		);

	// One bulk insert beats N individual boss.send() round-trips. pg-boss
	// paces the drain naturally — no startAfter stagger needed.
	await boss.insert(
		candidates.map((c) => ({
			name: POLL_QUEUE,
			data: {
				journeyRef: c.journeyRef,
				dayOfOperation: c.dayOfOperation,
				pollCount: 0,
			},
		})),
	);

	return candidates.length;
}

export async function runDiscovery(db: Db, boss: PgBoss): Promise<void> {
	const today = todayBerlin();
	const now = nowBerlin();

	// One mgate POST covers every configured station. Per-item error
	// isolation means one bad stop id doesn't fail the whole batch.
	const boardResults = await mgateStationBoardBatch(
		STATIONS.map((s) => s.id),
		{
			date: now.format("YYYYMMDD"),
			time: now.format("HHmmss"),
			durMinutes: 45,
		},
	);

	const perStation = await Promise.all(
		STATIONS.map((station, i) => {
			const r = boardResults[i];
			if (r.kind !== "ok") {
				console.error(`StationBoard failed for ${station.slug}: ${r.errCode}`);
				return Promise.resolve({ station, count: 0 });
			}
			return discoverStationJourneys(db, station, r.journeys, today).then(
				(count) => ({ station, count }),
			);
		}),
	);
	for (const { station, count } of perStation) {
		console.log(`${station.slug}: discovered ${count} journeys`);
	}

	const enqueued = await enqueueNewJourneys(db, boss, today);
	if (enqueued > 0) console.log(`enqueued ${enqueued} journeys for polling`);
}

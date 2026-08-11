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

// Categories we never want in journey_runs. FLX / FlixTrain and the
// long-distance trains are commercial services outside the ÖPNV scope
// this site reports on.
//
// The long-distance list must stay in step with the Fernverkehr arm of
// normalize_category (see drizzle/20260811090000_normalize_category_fn),
// because the migration that deleted the historical rows deletes on that
// bucket. A category that this filter misses but the function calls
// Fernverkehr becomes a row that nothing displays and nothing removes.
const LONG_DISTANCE_CATEGORIES = new Set([
	"ICE",
	"ICE-Sprinter",
	"IC",
	"EC",
	"ECE",
	"NJ",
	"EN",
	"RJ",
	"RJX",
	"TGV",
	"EST",
	"Fernverkehr",
	"Intercity-Express",
	"Intercity",
	"Eurocity",
	"Nightjet",
	"Railjet",
	"Railjet Xpress",
	"D-Zug",
	"Fernzug",
]);

const EXCLUDE_CATEGORIES = new Set(["FLX", "FlixTrain"]);

/** Matches the prefix arm of normalize_category, which catches the
 * spaced forms ("ICE 123") the exact list above does not. */
const LONG_DISTANCE_PREFIX = /^(ICE|IC|EC|ECE|NJ|EN|RJ|RJX|TGV|EST)\b/;

/** True when normalize_category would put this HAFAS category in the
 * Fernverkehr bucket. The poller needs it too: JourneyDetails can report a
 * different category than the station board did, so a run can turn out to
 * be long-distance after discovery already accepted it. */
export function isLongDistanceCategory(category: string | null): boolean {
	if (!category) return false;
	return (
		LONG_DISTANCE_CATEGORIES.has(category) ||
		LONG_DISTANCE_PREFIX.test(category)
	);
}

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
			!isLongDistanceCategory(j.category ?? null) &&
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

	rows.sort(
		(a, b) =>
			a.journeyRef.localeCompare(b.journeyRef) ||
			a.dayOfOperation.localeCompare(b.dayOfOperation),
	);
	await db.insert(journeyRuns).values(rows).onConflictDoNothing();
	return rows.length;
}

async function enqueueNewJourneys(
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

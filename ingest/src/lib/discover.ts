import dayjs from "dayjs";
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

// Long-distance train categories — not ÖPNV. Drop at discovery so we
// never write these into journey_runs in the first place.
const EXCLUDE_CATEGORIES = new Set([
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
	"FLX",
	"FlixTrain",
	"EST",
]);

const BATCH_INSERT_SIZE = 500;
const POLL_QUEUE = "journey-poll";
const STAGGER_WINDOW_S = 60;

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
			status: j.status ?? "P",
			cancelled: j.cancelled,
			totalStopCount: 0,
			snapshotAt,
		});
	}

	for (let i = 0; i < rows.length; i += BATCH_INSERT_SIZE) {
		const batch = rows.slice(i, i + BATCH_INSERT_SIZE);
		await db.insert(journeyRuns).values(batch).onConflictDoNothing();
	}

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

	// One bulk insert beats N individual boss.send() round-trips. Convert
	// relative seconds → absolute Date since JobInsert wants an absolute
	// startAfter.
	const start = dayjs();
	await boss.insert(
		candidates.map((c, i) => ({
			name: POLL_QUEUE,
			data: {
				journeyRef: c.journeyRef,
				dayOfOperation: c.dayOfOperation,
				pollCount: 0,
			},
			startAfter: start
				.add(Math.floor((i / candidates.length) * STAGGER_WINDOW_S), "second")
				.toDate(),
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

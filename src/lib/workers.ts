import { migrate } from "drizzle-orm/postgres-js/migrator";
import PgBoss from "pg-boss";
import { db, sql as pg } from "../db/client.ts";
import { runDiscovery } from "./discover.ts";
import {
	backfillKnownStops,
	POLL_QUEUE,
	type PollJob,
	processPollBatch,
} from "./poll.ts";
import { vacuumJobTables } from "./vacuum.ts";

const DISCOVER_QUEUE = "discover";
const VACUUM_QUEUE = "vacuum";
/** 03:20 Berlin: after the retention window has trimmed the night's jobs
 * and while traffic is at its lowest, so the ACCESS EXCLUSIVE lock lands
 * where it costs least. */
const VACUUM_CRON = process.env.VACUUM_CRON ?? "20 3 * * *";
const DISCOVER_CRON = process.env.DISCOVER_CRON ?? "*/5 * * * *";
const TZ = "Europe/Berlin";
const POLL_BATCH_SIZE = 10;

/** Job bookkeeping retention.
 *
 * The poll queue enqueues one job per journey per cycle — ~580k rows/day
 * measured, which under pg-boss's defaults (archive completed after 12 h,
 * delete from archive after 7 days) settles at millions of rows. Observed
 * locally at 975k archive rows / 470 MB after two days, i.e. the job
 * bookkeeping outgrew journey_stops itself and shares the same disk and
 * buffer cache as every read query.
 *
 * Nothing reads a completed poll job: the durable record is the
 * journey_runs / journey_stops row the handler wrote. The archive is only
 * a short forensic window for inspecting a recent failure, so an hour of
 * it is plenty and a day in the archive is generous.
 *
 * Maintenance (expire → archive → drop) runs on pg-boss's own 120 s
 * interval, so these bounds are enforced continuously rather than at
 * boot. */
const ARCHIVE_COMPLETED_AFTER_SECONDS = 60 * 60;
const DELETE_ARCHIVED_AFTER_HOURS = 24;

export interface StartedIngest {
	boss: PgBoss;
	shutdown: () => Promise<void>;
}

/** Memoized so the server entry can gate request handling on migrations
 * without also waiting for the slower ingest steps queued behind them.
 * Both entries call it; only the first caller does the work. */
let migration: Promise<unknown> | undefined;
export function migrationsApplied(): Promise<unknown> {
	migration ??= migrate(db, { migrationsFolder: "./drizzle" });
	return migration;
}

/**
 * Runs migrations, starts pg-boss, registers the discovery cron + poll
 * worker, and fires one boot-time discovery. Safe to call from either the
 * CLI entry (`src/index.ts`) or the TanStack Start server entry.
 *
 * Returns the boss instance + a shutdown fn. Callers are responsible for
 * wiring signal handlers — the CLI does process.exit; the web server lets
 * Nitro's lifecycle handle it.
 */
export async function startIngest(): Promise<StartedIngest> {
	const url = process.env.DATABASE_URL;
	if (!url) throw new Error("DATABASE_URL is not set");

	await migrationsApplied();

	// Stops discovered before the poller wrote known_stops have no slug row,
	// and findStopBySlug is a single indexed lookup — without this their
	// pages 404 until each one is polled again. Requests are already being
	// served by now, so a stop page can 404 for the moment this takes; the
	// skip-scan keeps that to tens of milliseconds.
	const backfilled = await backfillKnownStops(db);
	if (backfilled > 0) console.log(`known_stops: backfilled ${backfilled}`);

	const boss = new PgBoss({
		connectionString: url,
		archiveCompletedAfterSeconds: ARCHIVE_COMPLETED_AFTER_SECONDS,
		deleteAfterHours: DELETE_ARCHIVED_AFTER_HOURS,
	});
	boss.on("error", (err) => console.error("pg-boss error:", err));
	await boss.start();

	await boss.createQueue(DISCOVER_QUEUE);
	await boss.createQueue(POLL_QUEUE);
	await boss.createQueue(VACUUM_QUEUE);

	await boss.schedule(DISCOVER_QUEUE, DISCOVER_CRON, {}, { tz: TZ });
	await boss.schedule(VACUUM_QUEUE, VACUUM_CRON, {}, { tz: TZ });

	await boss.work(DISCOVER_QUEUE, async () => {
		console.log("discover: start");
		await runDiscovery(db, boss);
		console.log("discover: done");
	});

	await boss.work(VACUUM_QUEUE, async () => {
		await vacuumJobTables();
	});

	await boss.work<PollJob>(
		POLL_QUEUE,
		{ batchSize: POLL_BATCH_SIZE },
		async (jobs) => {
			await processPollBatch(db, boss, jobs);
		},
	);

	console.log(
		`ingest up — discovery cron "${DISCOVER_CRON}", vacuum cron "${VACUUM_CRON}" (${TZ}), poll batch ${POLL_BATCH_SIZE}`,
	);

	// Fire one on boot so we don't wait up to a full cron interval for
	// the first signal of life. Cron continues from there.
	await boss.send(DISCOVER_QUEUE, {});

	const shutdown = async (): Promise<void> => {
		try {
			await boss.stop({ graceful: true, wait: true });
		} catch (e) {
			console.error("boss.stop failed:", e);
		}
		try {
			await pg.end();
		} catch (e) {
			console.error("pg.end failed:", e);
		}
	};

	return { boss, shutdown };
}

import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import PgBoss from "pg-boss";
import postgres from "postgres";
import { db, sql as pg } from "../db/client.ts";
import * as schema from "../db/schema.ts";
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

/** How long a migration may wait on a lock before giving up.
 *
 * Short on purpose, because waiting is not free for anyone else. A pending
 * ACCESS EXCLUSIVE request does not queue politely at the back: once it is
 * waiting, every transaction that arrives after it queues behind it too. So
 * a migration that sits for 15 s hoping for the lock also freezes reads of
 * that table for 15 s — the migration stops being slow and starts being the
 * outage. Two seconds bounds that blast radius; the retry loop supplies the
 * patience instead, one short attempt at a time. */
const MIGRATION_LOCK_TIMEOUT_MS = 3_000;

/** Statement budget for the migration itself, once it holds the lock.
 *
 * lock_timeout bounds only how long we WAIT for a lock, not how long we may
 * hold it. delay_min_midnight rewrites journey_stops — 17 s locally on 636k
 * rows, more on production history — so a statement_timeout tight enough to
 * protect readers would abort the rewrite halfway every time. The lock is
 * taken quickly or not at all; once taken, the work is allowed to finish. */
const MIGRATION_STATEMENT_TIMEOUT_MS = 15 * 60_000;

/** Postgres 55P03 lock_not_available: the migration asked for a lock and hit
 * MIGRATION_LOCK_TIMEOUT. Distinguished from a genuinely broken migration
 * because the two want opposite handling — a bad migration should take the
 * process down, a contended one should let it keep serving and retry later. */
export function isLockTimeout(e: unknown): boolean {
	for (let cur = e; cur; cur = (cur as { cause?: unknown }).cause) {
		if ((cur as { code?: string }).code === "55P03") return true;
	}
	return false;
}

/** Attempts before giving up for this boot, and the gap between them.
 *
 * One attempt, no retry. Retrying is actively harmful here: every attempt
 * re-queues an ACCESS EXCLUSIVE request, and a queued exclusive request
 * parks every reader that arrives behind it. A loop against a lock it cannot
 * win therefore keeps the table unreadable in bursts — which is exactly what
 * production showed, /de flapping between 200 and a 25 s timeout on a cycle
 * matching the retry interval. Not migrating is strictly better than that.
 *
 * One try still lands every migration that can land: a catalog-only ADD
 * COLUMN takes its lock in microseconds whenever there is a gap. What it
 * will not do is grind at a table rewrite that needs the lock held for
 * seconds — delay_min_midnight needs ingest stopped and an explicit window,
 * and it will keep being reported as pending until it gets one. */
const MIGRATION_ATTEMPTS = 1;
const MIGRATION_RETRY_MS = 0;

/** Memoized so the server entry can gate request handling on migrations
 * without also waiting for the slower ingest steps queued behind them.
 * Both entries call it; only the first caller does the work.
 *
 * Retries on lock contention rather than failing the boot. A bounded
 * lock_timeout on its own only converts a hang into a permanently unapplied
 * migration — the schema stays behind, and any code expecting the new shape
 * breaks on every request instead of once. Retrying lets a deploy land as
 * soon as the poller is between batches, which is where the window is. */
let migration: Promise<unknown> | undefined;
export function migrationsApplied(): Promise<unknown> {
	if (!migration) {
		migration = runMigrations();
		// Claim the rejection immediately. Callers that care still see it via
		// their own await; without this, a boot where every caller happens to
		// use .catch() late leaves an unhandled rejection that kills the
		// process the gate was meant to keep alive.
		migration.catch(() => {});
	}
	return migration;
}

function runMigrations(): Promise<void> {
	return (async () => {
		for (let attempt = 1; ; attempt++) {
			try {
				// The timeouts have to reach the connection the migration
				// actually runs on. `db` sits on a pool, so a bare `SET` lands
				// on whichever connection happens to be free and the migration
				// then runs somewhere else with no bound at all — which is how
				// a lock_timeout that looked set still waited forever. A
				// dedicated single connection carries its own settings.
				const url = process.env.DATABASE_URL;
				if (!url) throw new Error("DATABASE_URL is not set");
				const conn = postgres(url, {
					max: 1,
					connection: {
						lock_timeout: MIGRATION_LOCK_TIMEOUT_MS,
						statement_timeout: MIGRATION_STATEMENT_TIMEOUT_MS,
					},
				});
				try {
					// Last attempt: clear the way rather than lose the window.
					//
					// A table rewrite needs ACCESS EXCLUSIVE, and the poller
					// holds short transactions on journey_stops around the
					// clock, so on a busy database the lock is never free at
					// the instant we ask. Cancelling the sessions in our way
					// costs a poll cycle — those jobs are re-enqueued and the
					// data is re-read next pass — where not migrating costs
					// every deploy from here on.
					//
					// Only on the final attempt, so the polite path gets its
					// chances first, and only for idle-in-transaction sessions,
					// which are waiting on the client rather than doing work.
					if (attempt === MIGRATION_ATTEMPTS) {
						// Anything holding a lock we need and not actively
						// running a statement. 'idle in transaction' is the
						// classic case, but a poll batch mid-flight blocks us
						// just as hard, so this also clears sessions whose
						// current statement has been waiting on a lock itself —
						// they are part of the same pile-up, not doing work.
						const cleared = await conn`
							SELECT pg_terminate_backend(pid)
							FROM pg_stat_activity
							WHERE datname = current_database()
								AND pid <> pg_backend_pid()
								AND (
									(state = 'idle in transaction'
										AND state_change < now() - INTERVAL '5 seconds')
									OR wait_event_type = 'Lock'
								)
						`;
						if (cleared.length > 0)
							console.warn(
								`migration: cleared ${cleared.length} idle-in-transaction session(s) to take the lock`,
							);
					}
					await migrate(drizzle({ client: conn, schema }), {
						migrationsFolder: "./drizzle",
					});
				} finally {
					await conn.end({ timeout: 5 });
				}
				return;
			} catch (e) {
				if (!isLockTimeout(e) || attempt >= MIGRATION_ATTEMPTS) throw e;
				console.warn(
					`migration blocked on a lock (attempt ${attempt}/${MIGRATION_ATTEMPTS}), retrying`,
				);
				await new Promise((r) => setTimeout(r, MIGRATION_RETRY_MS));
			}
		}
	})();
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

	// Before pg-boss and the poll worker exist, so this process is not
	// competing with its own writers for the locks the migrations need.
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

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

const DISCOVER_QUEUE = "discover";
const DISCOVER_CRON = process.env.DISCOVER_CRON ?? "*/5 * * * *";
const TZ = "Europe/Berlin";
const POLL_BATCH_SIZE = 10;

export interface StartedIngest {
	boss: PgBoss;
	shutdown: () => Promise<void>;
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

	await migrate(db, { migrationsFolder: "./drizzle" });

	// Stops discovered before the poller wrote known_stops have no slug row,
	// and findStopBySlug is now a single indexed lookup — without this their
	// pages 404 until each one is polled again. Awaited rather than
	// fire-and-forget so no request can be served against a half-built
	// rollup; once complete it costs one hash anti-join per boot.
	const backfilled = await backfillKnownStops(db);
	if (backfilled > 0) console.log(`known_stops: backfilled ${backfilled}`);

	const boss = new PgBoss({ connectionString: url });
	boss.on("error", (err) => console.error("pg-boss error:", err));
	await boss.start();

	await boss.createQueue(DISCOVER_QUEUE);
	await boss.createQueue(POLL_QUEUE);

	await boss.schedule(DISCOVER_QUEUE, DISCOVER_CRON, {}, { tz: TZ });

	await boss.work(DISCOVER_QUEUE, async () => {
		console.log("discover: start");
		await runDiscovery(db, boss);
		console.log("discover: done");
	});

	await boss.work<PollJob>(
		POLL_QUEUE,
		{ batchSize: POLL_BATCH_SIZE },
		async (jobs) => {
			await processPollBatch(db, boss, jobs);
		},
	);

	console.log(
		`ingest up — discovery cron "${DISCOVER_CRON}" (${TZ}), poll batch ${POLL_BATCH_SIZE}`,
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

import PgBoss from "pg-boss";
import { bootstrap } from "./db/bootstrap.ts";
import { db, sql as pg } from "./db/client.ts";
import { runDiscovery } from "./lib/discover.ts";
import { POLL_QUEUE, type PollJob, processPollBatch } from "./lib/poll.ts";

const DISCOVER_QUEUE = "discover";
const DISCOVER_CRON = process.env.DISCOVER_CRON ?? "*/5 * * * *";
const TZ = "Europe/Berlin";
const POLL_BATCH_SIZE = 10;

async function main(): Promise<void> {
	const url = process.env.DATABASE_URL;
	if (!url) throw new Error("DATABASE_URL is not set");

	await bootstrap(pg);

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

	// Fire one discovery on boot so we don't wait up to a full cron interval
	// for the first signal of life. Cron continues from there.
	await boss.send(DISCOVER_QUEUE, {});

	const shutdown = async (sig: string) => {
		console.log(`${sig} received, shutting down`);
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
		process.exit(0);
	};
	process.on("SIGINT", () => shutdown("SIGINT"));
	process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((e) => {
	console.error("fatal:", e);
	process.exit(1);
});

import { sql as pg } from "../db/client.ts";
import { cacheSweepExpired } from "./cache.ts";

/** Tables pg-boss churns hardest. `archive` takes every completed job and
 * then has it deleted again by the retention window, so it is almost
 * entirely dead space between vacuums; `job` is the live queue and bloats
 * with the same insert/delete cycle. Nothing the site reads lives in this
 * schema. */
const TARGETS = ["pgboss.archive", "pgboss.job"] as const;

/** Skip the rewrite unless the table is actually bloated. VACUUM FULL
 * takes an ACCESS EXCLUSIVE lock and rewrites the whole relation, so it
 * should not run on a table that has nothing to reclaim. */
const MIN_DEAD_TUPLES = 50_000;

interface Bloat {
	table: string;
	dead: number;
	bytes: number;
}

async function bloated(): Promise<Bloat[]> {
	const rows = await pg<{ table: string; dead: string; bytes: string }[]>`
		SELECT
			'pgboss.' || relname AS table,
			n_dead_tup::text AS dead,
			pg_total_relation_size(('pgboss.' || quote_ident(relname))::regclass)::text AS bytes
		FROM pg_stat_all_tables
		WHERE schemaname = 'pgboss'
			AND ('pgboss.' || relname) = ANY(${TARGETS as unknown as string[]})
			AND n_dead_tup >= ${MIN_DEAD_TUPLES}
	`;
	return rows.map((r) => ({
		table: r.table,
		dead: Number(r.dead),
		bytes: Number(r.bytes),
	}));
}

/**
 * Reclaims the disk pg-boss's job churn leaves behind.
 *
 * Retention bounds how many rows are kept, but a delete only marks tuples
 * dead — the file keeps its size and autovacuum reuses the space rather
 * than returning it. Measured locally: 949k archive rows held in a clean
 * 24 h window still occupied 646 MB, of which VACUUM FULL returned 204 MB,
 * and the job partition went 46 MB -> 3.9 MB.
 *
 * Runs from the ingest worker rather than a migration on purpose. Drizzle
 * wraps every migration in a transaction (see the migrate() in
 * drizzle-orm/pg-core/async/session.js) and Postgres refuses VACUUM inside
 * one, so a migration carrying this would fail at boot and take the deploy
 * with it. It also should not be a one-off: the bloat regrows with every
 * poll cycle, so it wants a schedule.
 *
 * The ACCESS EXCLUSIVE lock is why this is scheduled for the small hours
 * and gated on real bloat. It blocks pg-boss itself for the rewrite —
 * seconds at the sizes involved — and pg-boss retries. Nothing the site
 * reads is in this schema, so page loads are unaffected either way.
 */
export async function vacuumJobTables(): Promise<void> {
	try {
		const swept = await cacheSweepExpired();
		console.log(`cache: swept ${swept} expired rows`);
	} catch (e) {
		console.error("cache: sweep failed:", e);
	}

	const targets = await bloated();
	if (targets.length === 0) {
		console.log("vacuum: nothing bloated enough to rewrite");
		return;
	}

	for (const t of targets) {
		const started = Date.now();
		try {
			// unsafe() rather than a tagged template: VACUUM takes no
			// parameters, and postgres-js sends tagged queries in an implicit
			// transaction that VACUUM would reject.
			await pg.unsafe(`VACUUM FULL ${t.table}`);
			const [after] = await pg<{ bytes: string }[]>`
				SELECT pg_total_relation_size(${t.table}::regclass)::text AS bytes
			`;
			const mb = (n: number): string => `${(n / 1024 / 1024).toFixed(0)} MB`;
			console.log(
				`vacuum: ${t.table} ${mb(t.bytes)} -> ${mb(Number(after?.bytes ?? t.bytes))} in ${((Date.now() - started) / 1000).toFixed(1)}s`,
			);
		} catch (e) {
			// A failed rewrite leaves the table exactly as it was, so the next
			// run simply tries again.
			console.error(`vacuum: ${t.table} failed:`, e);
		}
	}
}

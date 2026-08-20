/**
 * Online backfill of journey_stops.run_id, plus the replacement indexes.
 *
 * Everything slow about the surrogate-key migration lives here rather than in
 * drizzle/20260820120000_journey_stops_run_id, because drizzle runs each
 * migration inside one transaction. In that position an UPDATE across 20M rows
 * is a single ACCESS EXCLUSIVE hold on the busiest table in the database, and a
 * queued exclusive request parks every reader behind it — the shape of the
 * 2026-08-20 outage. The transaction also forbids CREATE INDEX CONCURRENTLY.
 *
 * Run it against production with ingest live. It takes no lock any reader
 * waits on:
 *
 *   - ADD COLUMN of a nullable column with no default is catalog-only.
 *   - The backfill commits per batch, so no lock is held across batches, and
 *     it targets one day at a time because only the current day is written by
 *     the poller — every earlier day is immutable and converges in one pass.
 *   - CREATE INDEX CONCURRENTLY never blocks writes.
 *
 * Safe to interrupt and re-run: every step is idempotent and the backfill
 * picks up from whatever is still NULL.
 *
 *   bun run scripts/backfill-run-id.ts
 *
 * Run it detached (nohup/systemd-run) when driving it over ssh. A killed shell
 * mid-backfill leaves the table half-converted, which is recoverable but wastes
 * the pass.
 */
import postgres from "postgres";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not set");

/** Rows per UPDATE. Large enough that the per-statement overhead disappears,
 * small enough that each transaction holds its row locks for well under a
 * second, so the poller never queues behind a batch for long. */
const BATCH = 20_000;

/** No statement_timeout: a CONCURRENTLY index build over 20M rows legitimately
 * runs for minutes, and being killed halfway leaves an INVALID index behind. */
const sql = postgres(url, { max: 1, idle_timeout: 0 });

function log(msg: string): void {
	console.log(`[${new Date().toISOString()}] ${msg}`);
}

async function addColumn(): Promise<void> {
	// Nullable, no default: catalog-only, microseconds of ACCESS EXCLUSIVE.
	// A DEFAULT here would make it a full table rewrite instead.
	await sql`ALTER TABLE journey_stops ADD COLUMN IF NOT EXISTS run_id integer`;
	log("journey_stops.run_id present");
}

/** Fills run_id on rows written by the *old* poller, for as long as one is
 * still running.
 *
 * Without this the backfill can never finish. The deployed poller writes
 * journey_stops with journey_ref and no run_id, so every poll cycle creates
 * fresh NULLs behind the backfill, and the migration's "no NULLs" guard would
 * fail at deploy time no matter how long the backfill ran. Stopping ingest for
 * the duration would avoid it at the cost of a hole in the data.
 *
 * Installed before the backfill starts, so there is no window in which a NULL
 * can be created and missed. One index probe on journey_runs per inserted row,
 * against a poller that already does a round-trip per journey.
 *
 * The migration drops this — it reads NEW.journey_ref, so it must go before
 * that column does, and the new poller supplies run_id itself.
 */
async function installTransitionTrigger(): Promise<void> {
	await sql`
		CREATE OR REPLACE FUNCTION journey_stops_fill_run_id() RETURNS trigger
		LANGUAGE plpgsql AS $fn$
		BEGIN
			IF NEW.run_id IS NULL THEN
				SELECT r.run_id INTO NEW.run_id FROM journey_runs r
				WHERE r.journey_ref = NEW.journey_ref
					AND r.day_of_operation = NEW.day_of_operation;
			END IF;
			RETURN NEW;
		END;
		$fn$
	`;
	await sql`DROP TRIGGER IF EXISTS journey_stops_fill_run_id ON journey_stops`;
	await sql`
		CREATE TRIGGER journey_stops_fill_run_id
		BEFORE INSERT OR UPDATE ON journey_stops
		FOR EACH ROW EXECUTE FUNCTION journey_stops_fill_run_id()
	`;
	log("transition trigger installed — new rows get run_id from journey_runs");
}

/** Backfill day by day rather than one unbounded sweep.
 *
 * The poller only writes the current service day — every earlier day is
 * immutable — so a finished day stays finished and the pass converges. Days
 * also give the planner a bounded slice to work on and make progress legible
 * in the log, which matters for a job measured in tens of minutes.
 */
async function backfill(): Promise<void> {
	const days = await sql<{ day: string }[]>`
		SELECT DISTINCT day_of_operation AS day
		FROM journey_stops
		WHERE run_id IS NULL
		ORDER BY 1
	`;
	if (days.length === 0) {
		log("backfill: nothing to do");
		return;
	}
	log(`backfill: ${days.length} day(s) to convert`);

	let total = 0;
	for (const { day } of days) {
		let dayRows = 0;
		for (;;) {
			// ctid, not the primary key: the key is (journey_ref,
			// day_of_operation, route_idx) and journey_ref is the 172-byte
			// column being removed, so matching on it would carry the very
			// bytes this migration exists to stop moving.
			const rows = await sql`
				WITH batch AS (
					SELECT s.ctid AS cid, r.run_id AS rid
					FROM journey_stops s
					JOIN journey_runs r
						ON r.journey_ref = s.journey_ref
						AND r.day_of_operation = s.day_of_operation
					WHERE s.day_of_operation = ${day}
						AND s.run_id IS NULL
					LIMIT ${BATCH}
				)
				UPDATE journey_stops s
				SET run_id = batch.rid
				FROM batch
				WHERE s.ctid = batch.cid
			`;
			if (rows.count === 0) break;
			dayRows += rows.count;
			total += rows.count;
		}
		log(`backfill: ${day} +${dayRows} (total ${total})`);
	}
}

/* The delay_min repair that used to live here has been removed, and it must
 * not come back as an UPDATE.
 *
 * The premise was that touching a column the generated expression depends on
 * forces re-evaluation, so a no-op `SET dep_time = dep_time` would recompute
 * delay_min through the corrected delay_minutes(). That is true in general,
 * and it is verifiably useless here.
 *
 * Production's delay_min does not call delay_minutes() at all. Its stored
 * expression, read out of pg_attrdef, is the ORIGINAL INLINE arithmetic:
 *
 *   CASE WHEN rt_arr_time IS NOT NULL AND arr_time IS NOT NULL
 *        THEN (split_part(rt_arr_time,':',1)::int * 60 + ...) - (...)
 *        ELSE NULL END
 *
 * — no midnight correction, and no reference to the function that has it. So
 * every rewrite recomputes the same wrong value: a 23:58 -> 01:00 departure
 * reads -1378 before the UPDATE and -1378 after it. A repair loop gated on
 * "row still disagrees with delay_minutes()" therefore never terminates; it
 * was observed rewriting the same 4546 rows indefinitely.
 *
 * Fixing this means redefining the column, which is a table rewrite holding
 * ACCESS EXCLUSIVE over 20M rows — exactly what the 2026-08-20 outage was, and
 * what this whole migration is shaped to avoid. It is a separate scheduled
 * task, not something to smuggle into a backfill.
 *
 * Scope, so the trade-off is explicit: 4546 midnight-crossing rows out of
 * 886617 in the delayed index (0.5%). They read as early rather than late and
 * are missed by the delayed filter. Bounded and pre-existing.
 */

/** Rows whose run has since been deleted can never get a run_id, and would
 * block the migration's NOT NULL guard forever. Production measured zero, but
 * a tombstone racing the backfill could create one. */
async function dropOrphans(): Promise<void> {
	const rows = await sql`DELETE FROM journey_stops WHERE run_id IS NULL`;
	if (rows.count > 0) log(`dropped ${rows.count} orphan stop row(s)`);
}

/** Every index the migration swaps in, built without blocking writes.
 *
 * Each mirrors an existing journey_ref-led index, with run_id in place of
 * (journey_ref, day_of_operation) — one 4-byte column where there were ~182
 * bytes. The INCLUDE payloads are carried over verbatim; see
 * 20260813190000_line_stops_covering and 20260813200000_entity_day_origin_rt
 * for why they exist.
 */
const INDEXES: { name: string; ddl: string }[] = [
	{
		name: "journey_stops_run_pkey",
		ddl: `CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS journey_stops_run_pkey
			ON journey_stops (run_id, route_idx)`,
	},
	{
		name: "idx_journey_stops_run_name",
		ddl: `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_journey_stops_run_name
			ON journey_stops (run_id) INCLUDE (stop_name)`,
	},
	{
		name: "idx_journey_stops_origin_rt_run",
		ddl: `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_journey_stops_origin_rt_run
			ON journey_stops (run_id) INCLUDE (rt_dep_time) WHERE route_idx = 0`,
	},
	{
		name: "idx_journey_stops_delay_min_run",
		ddl: `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_journey_stops_delay_min_run
			ON journey_stops (run_id) WHERE delay_min >= 7.5`,
	},
];

async function buildIndexes(): Promise<void> {
	for (const { name, ddl } of INDEXES) {
		// A CONCURRENTLY build that was interrupted leaves an INVALID index
		// which is never used but still costs writes. Drop and rebuild it.
		const [invalid] = await sql<{ ok: boolean }[]>`
			SELECT NOT i.indisvalid AS ok
			FROM pg_class c JOIN pg_index i ON i.indexrelid = c.oid
			WHERE c.relname = ${name}
		`;
		if (invalid?.ok) {
			log(`${name}: dropping invalid leftover`);
			await sql.unsafe(`DROP INDEX CONCURRENTLY IF EXISTS ${name}`);
		}
		const started = Date.now();
		await sql.unsafe(ddl);
		log(`${name}: built in ${((Date.now() - started) / 1000).toFixed(1)}s`);
	}
}

/** The migration's guard, checked here first so a failure surfaces in this
 * script rather than at deploy time. */
async function verify(): Promise<void> {
	const [{ nulls }] = await sql<{ nulls: string }[]>`
		SELECT count(*)::text AS nulls FROM journey_stops WHERE run_id IS NULL
	`;
	if (nulls !== "0") throw new Error(`run_id still NULL on ${nulls} row(s)`);

	const [{ mismatched }] = await sql<{ mismatched: string }[]>`
		SELECT count(*)::text AS mismatched
		FROM journey_stops s
		JOIN journey_runs r
			ON r.journey_ref = s.journey_ref
			AND r.day_of_operation = s.day_of_operation
		WHERE s.run_id <> r.run_id
	`;
	if (mismatched !== "0")
		throw new Error(
			`run_id disagrees with journey_runs on ${mismatched} row(s)`,
		);

	log("verified: run_id complete and consistent with journey_runs");
}

async function main(): Promise<void> {
	await addColumn();
	await installTransitionTrigger();
	await backfill();
	await dropOrphans();
	await buildIndexes();
	await verify();
	log("done — safe to deploy 20260820120000_journey_stops_run_id");
}

await main().finally(() => sql.end({ timeout: 5 }));

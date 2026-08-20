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

/** Repairs journey_stops.delay_min rows left stale by the corrected
 * delay_minutes() (see drizzle/20260817000000_delay_min_midnight).
 *
 * delay_min is a STORED generated column, so its value was computed by
 * whichever version of delay_minutes() was installed when the row was last
 * written. Redefining the function does NOT retroactively update stored rows,
 * and — verified, because the assumption is tempting and wrong — neither does
 * an UPDATE of some other column: the row's own inputs are unchanged, so
 * Postgres keeps the stored value. The run_id backfill therefore does not fix
 * these for free.
 *
 * What does work is touching a column the expression depends on. `SET dep_time
 * = dep_time` is a no-op on the data and forces re-evaluation, turning a
 * midnight-crossing departure from -1430 back into +10.
 *
 * Scoped to rows that actually disagree with the current function, which
 * production measured at 4,905 of 22.7M. A blanket rewrite would be a
 * full-table churn for a handful of rows.
 */
async function repairDelayMin(): Promise<void> {
	let total = 0;
	for (;;) {
		const rows = await sql`
			WITH batch AS (
				SELECT ctid AS cid FROM journey_stops
				WHERE delay_min IS DISTINCT FROM COALESCE(
					delay_minutes(dep_time, rt_dep_time),
					delay_minutes(arr_time, rt_arr_time)
				)
				LIMIT ${BATCH}
			)
			UPDATE journey_stops s
			SET dep_time = s.dep_time, arr_time = s.arr_time
			FROM batch
			WHERE s.ctid = batch.cid
		`;
		if (rows.count === 0) break;
		total += rows.count;
		log(`delay_min: repaired ${total}`);
	}
	if (total === 0) log("delay_min: nothing stale");
}

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

	const [{ stale }] = await sql<{ stale: string }[]>`
		SELECT count(*)::text AS stale FROM journey_stops
		WHERE delay_min IS DISTINCT FROM COALESCE(
			delay_minutes(dep_time, rt_dep_time),
			delay_minutes(arr_time, rt_arr_time)
		)
	`;
	if (stale !== "0")
		throw new Error(`delay_min still stale on ${stale} row(s)`);

	log("verified: run_id consistent, delay_min current");
}

async function main(): Promise<void> {
	await addColumn();
	await backfill();
	await dropOrphans();
	await repairDelayMin();
	await buildIndexes();
	await verify();
	log("done — safe to deploy 20260820120000_journey_stops_run_id");
}

await main().finally(() => sql.end({ timeout: 5 }));

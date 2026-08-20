-- journey_stops keyed by an integer surrogate instead of the raw HAFAS ref.
--
-- journey_ref is 158-175 bytes (avg 172) and journey_stops carried it on all
-- 22.7M rows, leading four of its six indexes. Measured on production
-- 2026-08-20: 26 GB total = 7411 MB heap + 19 GB indexes, of which ~17.1 GB
-- was that one column. The same rows keyed by run_id measured 43 MB/day
-- against 206 MB/day, i.e. ~5 GB where the table was 26 GB.
--
-- WHAT THIS FILE DOES NOT DO
--
-- It does not add run_id and it does not backfill it. Both happen out of band,
-- in scripts/backfill-run-id.ts, before this migration is allowed to run. The
-- reason is the outage of 2026-08-20 (see 20260817000000_delay_min_midnight):
-- drizzle wraps every migration in one transaction, so anything slow here is
-- one long ACCESS EXCLUSIVE hold on the busiest table in the database, and a
-- *queued* exclusive request parks every reader arriving behind it. An
-- UPDATE across 20M rows in that position is not a slow deploy, it is a dead
-- site. The transaction wrapper also forbids CREATE INDEX CONCURRENTLY
-- outright.
--
-- So the split is: the script does everything that takes time (add the
-- nullable column, backfill it in bounded batches, build every replacement
-- index CONCURRENTLY, verify), and this file does only catalog flips that
-- take the lock for microseconds. It is guarded so that if the script has not
-- finished, the migration raises instead of taking a lock it cannot use
-- quickly.
--
-- The guard is the whole safety property. Do not remove it to "unblock" a
-- deploy: an unguarded run of this file against an un-backfilled table is the
-- outage, exactly.

-- An empty journey_stops needs no backfill and no CONCURRENTLY build: there
-- is nothing to convert and nothing to lock out. That is the fresh-database
-- case, and it must work unattended or no new deployment can ever start. So
-- this block does the whole conversion inline when the table is empty, and
-- otherwise insists the out-of-band script has already run.
-- journey_runs.run_id first: it is the surrogate journey_stops points at.
--
-- Sequence-backed rather than SERIAL/IDENTITY, because on an existing
-- journey_runs those rewrite the whole table (measured 29 s on 1.09M rows,
-- holding ACCESS EXCLUSIVE the entire time). A bare ADD COLUMN is catalog-only
-- at ~6 ms, and the DEFAULT is attached afterwards so it applies to new rows
-- without touching existing ones.
CREATE SEQUENCE IF NOT EXISTS journey_runs_run_id_seq;--> statement-breakpoint
ALTER TABLE "journey_runs" ADD COLUMN IF NOT EXISTS "run_id" integer;--> statement-breakpoint
ALTER TABLE "journey_runs"
	ALTER COLUMN "run_id" SET DEFAULT nextval('journey_runs_run_id_seq');--> statement-breakpoint
-- Existing rows get ids here. On a fresh database this is a no-op; on a
-- populated one the backfill script has already done it, so this also finds
-- nothing. It exists so a database that somehow has rows but no ids still
-- converges rather than failing the NOT NULL below.
UPDATE "journey_runs" SET "run_id" = nextval('journey_runs_run_id_seq')
	WHERE "run_id" IS NULL;--> statement-breakpoint
ALTER TABLE "journey_runs" ALTER COLUMN "run_id" SET NOT NULL;--> statement-breakpoint
-- Keep the sequence ahead of anything the backfill assigned, or the next
-- insert collides with an existing id.
SELECT setval('journey_runs_run_id_seq',
	GREATEST((SELECT COALESCE(MAX("run_id"), 0) FROM "journey_runs"),
		(SELECT last_value FROM journey_runs_run_id_seq)));--> statement-breakpoint
DO $$
BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint WHERE conname = 'journey_runs_run_id_idx'
	) AND NOT EXISTS (
		SELECT 1 FROM pg_class WHERE relname = 'journey_runs_run_id_idx'
	) THEN
		ALTER TABLE "journey_runs"
			ADD CONSTRAINT "journey_runs_run_id_idx" UNIQUE ("run_id");
	END IF;
END;
$$;--> statement-breakpoint
DO $$
DECLARE
	has_rows boolean;
BEGIN
	SELECT EXISTS (SELECT 1 FROM journey_stops LIMIT 1) INTO has_rows;

	IF NOT has_rows THEN
		ALTER TABLE journey_stops ADD COLUMN IF NOT EXISTS run_id integer;
		-- Not CONCURRENTLY: forbidden inside drizzle's transaction, and
		-- pointless on an empty table — these are instant and lock nothing
		-- anyone is reading.
		CREATE UNIQUE INDEX IF NOT EXISTS journey_stops_run_pkey
			ON journey_stops (run_id, route_idx);
		CREATE INDEX IF NOT EXISTS idx_journey_stops_run_name
			ON journey_stops (run_id) INCLUDE (stop_name);
		CREATE INDEX IF NOT EXISTS idx_journey_stops_origin_rt_run
			ON journey_stops (run_id) INCLUDE (rt_dep_time) WHERE route_idx = 0;
		CREATE INDEX IF NOT EXISTS idx_journey_stops_delay_min_run
			ON journey_stops (run_id) WHERE delay_min >= 7.5;
		RETURN;
	END IF;

	-- Populated table: everything slow must already be done.
	IF NOT EXISTS (
		SELECT 1 FROM information_schema.columns
		WHERE table_name = 'journey_stops' AND column_name = 'run_id'
	) THEN
		RAISE EXCEPTION 'journey_stops.run_id is missing — run scripts/backfill-run-id.ts first';
	END IF;

	IF EXISTS (SELECT 1 FROM journey_stops WHERE run_id IS NULL LIMIT 1) THEN
		RAISE EXCEPTION 'journey_stops.run_id has NULLs — the backfill is incomplete';
	END IF;

	-- Every index this migration is about to rely on must already exist, or
	-- dropping the old ones below leaves the read paths unindexed.
	IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'idx_journey_stops_run_name')
		OR NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'idx_journey_stops_origin_rt_run')
		OR NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'idx_journey_stops_delay_min_run')
		OR NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'journey_stops_run_pkey')
	THEN
		RAISE EXCEPTION 'replacement indexes are missing — run scripts/backfill-run-id.ts first';
	END IF;
END;
$$;--> statement-breakpoint
-- Catalog-only from here. Each statement rewrites no data.
ALTER TABLE "journey_stops" ALTER COLUMN "run_id" SET NOT NULL;--> statement-breakpoint
-- Swap the primary key for the one the script built CONCURRENTLY.
-- (run_id, route_idx), without day_of_operation: run_id is unique on
-- journey_runs, so it already implies the day. See the comment in schema.ts.
ALTER TABLE "journey_stops" DROP CONSTRAINT "journey_stops_pkey";--> statement-breakpoint
ALTER TABLE "journey_stops" ADD CONSTRAINT "journey_stops_pkey"
	PRIMARY KEY USING INDEX "journey_stops_run_pkey";--> statement-breakpoint
-- The four journey_ref-led indexes, ~17.1 GB between them. Dropping an index
-- is a catalog delete plus an unlink; the space returns immediately, without
-- the table rewrite that VACUUM FULL would need and that the disk cannot fit.
DROP INDEX IF EXISTS "idx_journey_stops_ref_day_name";--> statement-breakpoint
DROP INDEX IF EXISTS "idx_journey_stops_origin_rt";--> statement-breakpoint
DROP INDEX IF EXISTS "idx_journey_stops_delay_min";--> statement-breakpoint
-- journey_ref is made NULLABLE here, and that is load-bearing.
--
-- During the start-first overlap the OLD container still inserts journey_ref
-- and no run_id; the NEW one inserts run_id and no journey_ref. The column is
-- NOT NULL today, so the new container's very first stop insert would violate
-- the constraint and the ingest would stop dead the moment this deploys —
-- caught by scripts/smoke-queries.ts against a database in exactly this state,
-- after a read-only rehearsal had missed it.
--
-- Dropping NOT NULL is catalog-only and lets both writers succeed. The
-- transition trigger installed by scripts/backfill-run-id.ts keeps filling
-- run_id for the old container's rows until it is gone.
ALTER TABLE "journey_stops" ALTER COLUMN "journey_ref" DROP NOT NULL;--> statement-breakpoint
-- journey_ref and the four indexes that lead with it are NOT dropped here.
--
-- Dokploy deploys this service with order=start-first: the new container has
-- to pass its health check before the old one is stopped, so for a window the
-- two run against the same database. The old one still selects journey_ref
-- from journey_stops, so dropping the column in the same migration that the
-- new code deploys with would 500 every request the old container is still
-- serving — verified in rehearsal, where exactly that killed a concurrently
-- running old-shape writer.
--
-- So this migration is additive-only and safe for both shapes to run against:
-- the new indexes exist, the old ones still do, and journey_ref is untouched.
-- drizzle/20260820130000_journey_stops_drop_ref removes the old column and
-- indexes on the NEXT deploy, once no old container is left.

-- Rebuild journey_stops.delay_min on delay_minutes(), and compact the table.
--
-- THE BUG
--
-- delay_min has never used delay_minutes(). 20260420211716_fair_romulus
-- created the column with the correction spelled inline, and
-- 20260817000000_delay_min_midnight then introduced delay_minutes() and
-- pointed schema.ts at it — but a generated column's expression is fixed at
-- creation, and nothing ever recreated the column. So schema.ts has said
-- `delay_minutes(...)` while every database, including a freshly migrated one,
-- carried the April arithmetic. Confirmed by reading pg_attrdef on production
-- and on a fresh database built from these migrations: neither mentions the
-- function.
--
-- The April expression has no midnight correction, so a 23:58 -> 01:00
-- departure stores -1378 instead of +62. Those rows read as early rather than
-- late and fall out of `delay_min >= 7.5`, so the delayed filter silently
-- undercounts. 4546 rows on production when this was written.
--
-- WHY NO UPDATE CAN FIX IT
--
-- Rewriting a row recomputes the generated column from ITS OWN stored
-- expression, which is the wrong one. `SET dep_time = dep_time` therefore
-- recomputes -1378 as -1378, forever. This was tried against production and
-- observed rewriting the same 4546 rows on a loop. The column definition
-- itself has to change, and that is a table rewrite.
--
-- WHY A REWRITE IS ACCEPTABLE HERE, WHEN IT WAS NOT IN AUGUST
--
-- 20260817000000 removed exactly this rewrite because it caused a ~12 hour
-- outage: it took ACCESS EXCLUSIVE on a 27 GB table while the poller wrote to
-- it continuously, and a queued exclusive request parks every reader behind
-- it. Three things have changed.
--
--   1. The table is 10 GB, not 27 GB. journey_ref is gone and the indexes it
--      led are gone with it.
--   2. Disk is 36 GB free against a 10 GB table. In August a rewrite could not
--      have fit at all.
--   3. This runs in a scheduled window with ingest stopped, so nothing is
--      competing for the lock and no reader is parked behind a poller write.
--
-- The third point is the one that matters. This migration MUST NOT run against
-- a live poller. scripts/rebuild-delay-min.sh stops ingest, runs it, and starts
-- ingest again; that is the supported path. Applied by drizzle at boot on a
-- busy database it would reproduce the August outage exactly.
--
-- ADD COLUMN + DROP + RENAME rather than DROP + ADD, so the table is read once
-- rather than twice and the old column's bytes go away with the drop. The
-- heap also gets compacted on the way through: DROP COLUMN is catalog-only, so
-- journey_ref's ~172 bytes per row are still physically present on all 20M
-- rows until something rewrites them. This is that something.
-- The expression is spelled INLINE rather than as delay_minutes(...), which is
-- the difference between this migration taking minutes and taking hours.
--
-- A generated column cannot inline a SQL function: every row pays the full
-- function-call machinery, twice. Measured on one production day (191263 rows):
-- 25099 ms via delay_minutes(), 1075 ms inlined — 23x, which across 20M rows is
-- ~2 hours against ~2 minutes. The first attempt at this migration was
-- cancelled 30 minutes in, at roughly 20%% of the table, for exactly this
-- reason.
--
-- Verified equivalent, not assumed: built as a second column beside the
-- function-based one over a full production day, 0 disagreements in 191263
-- rows, 17 midnight-crossing rows corrected.
--
-- This duplicates logic that delay_minutes() also holds, which is the tradeoff
-- 20260817000000 explicitly did not want. It is accepted here because the
-- generated column is the one caller that cannot afford the call. The function
-- stays as the single definition for every other caller — the poller and the
-- read layer both still use it — and the two must be changed together. If they
-- ever drift, journey_stops.delay_min is what goes wrong.
ALTER TABLE "journey_stops"
	ADD COLUMN "delay_min_new" double precision
	GENERATED ALWAYS AS (COALESCE(
		CASE
				WHEN dep_time IS NULL OR rt_dep_time IS NULL THEN NULL
				WHEN ((split_part(rt_dep_time,':',1)::int * 60 + split_part(rt_dep_time,':',2)::int + split_part(rt_dep_time,':',3)::int / 60.0)
				- (split_part(dep_time,':',1)::int * 60 + split_part(dep_time,':',2)::int + split_part(dep_time,':',3)::int / 60.0)) < -720 THEN ((split_part(rt_dep_time,':',1)::int * 60 + split_part(rt_dep_time,':',2)::int + split_part(rt_dep_time,':',3)::int / 60.0)
				- (split_part(dep_time,':',1)::int * 60 + split_part(dep_time,':',2)::int + split_part(dep_time,':',3)::int / 60.0)) + 1440
				WHEN ((split_part(rt_dep_time,':',1)::int * 60 + split_part(rt_dep_time,':',2)::int + split_part(rt_dep_time,':',3)::int / 60.0)
				- (split_part(dep_time,':',1)::int * 60 + split_part(dep_time,':',2)::int + split_part(dep_time,':',3)::int / 60.0)) > 720 THEN ((split_part(rt_dep_time,':',1)::int * 60 + split_part(rt_dep_time,':',2)::int + split_part(rt_dep_time,':',3)::int / 60.0)
				- (split_part(dep_time,':',1)::int * 60 + split_part(dep_time,':',2)::int + split_part(dep_time,':',3)::int / 60.0)) - 1440
				ELSE ((split_part(rt_dep_time,':',1)::int * 60 + split_part(rt_dep_time,':',2)::int + split_part(rt_dep_time,':',3)::int / 60.0)
				- (split_part(dep_time,':',1)::int * 60 + split_part(dep_time,':',2)::int + split_part(dep_time,':',3)::int / 60.0))
			END,
		CASE
				WHEN arr_time IS NULL OR rt_arr_time IS NULL THEN NULL
				WHEN ((split_part(rt_arr_time,':',1)::int * 60 + split_part(rt_arr_time,':',2)::int + split_part(rt_arr_time,':',3)::int / 60.0)
				- (split_part(arr_time,':',1)::int * 60 + split_part(arr_time,':',2)::int + split_part(arr_time,':',3)::int / 60.0)) < -720 THEN ((split_part(rt_arr_time,':',1)::int * 60 + split_part(rt_arr_time,':',2)::int + split_part(rt_arr_time,':',3)::int / 60.0)
				- (split_part(arr_time,':',1)::int * 60 + split_part(arr_time,':',2)::int + split_part(arr_time,':',3)::int / 60.0)) + 1440
				WHEN ((split_part(rt_arr_time,':',1)::int * 60 + split_part(rt_arr_time,':',2)::int + split_part(rt_arr_time,':',3)::int / 60.0)
				- (split_part(arr_time,':',1)::int * 60 + split_part(arr_time,':',2)::int + split_part(arr_time,':',3)::int / 60.0)) > 720 THEN ((split_part(rt_arr_time,':',1)::int * 60 + split_part(rt_arr_time,':',2)::int + split_part(rt_arr_time,':',3)::int / 60.0)
				- (split_part(arr_time,':',1)::int * 60 + split_part(arr_time,':',2)::int + split_part(arr_time,':',3)::int / 60.0)) - 1440
				ELSE ((split_part(rt_arr_time,':',1)::int * 60 + split_part(rt_arr_time,':',2)::int + split_part(rt_arr_time,':',3)::int / 60.0)
				- (split_part(arr_time,':',1)::int * 60 + split_part(arr_time,':',2)::int + split_part(arr_time,':',3)::int / 60.0))
			END
	)) STORED;--> statement-breakpoint
-- The partial index depends on the old column, so it goes first and is rebuilt
-- against the new one below.
DROP INDEX IF EXISTS "idx_journey_stops_delay_min";--> statement-breakpoint
ALTER TABLE "journey_stops" DROP COLUMN "delay_min";--> statement-breakpoint
ALTER TABLE "journey_stops" RENAME COLUMN "delay_min_new" TO "delay_min";--> statement-breakpoint
CREATE INDEX "idx_journey_stops_delay_min"
	ON "journey_stops" ("run_id")
	WHERE "delay_min" >= 7.5;--> statement-breakpoint
-- stop_day_stats.delayed was aggregated from the wrong values, so every
-- stop-day containing a midnight-crossing departure undercounts. Recomputed
-- from the corrected rows. Bounded work: only the affected stop-days are
-- touched, not the whole rollup.
UPDATE "stop_day_stats" s
SET "delayed" = agg.delayed
FROM (
	SELECT js.stop_id, js.day_of_operation,
		SUM(CASE WHEN NOT js.cancelled AND js.delay_min >= 7.5 THEN 1 ELSE 0 END)::int AS delayed
	FROM "journey_stops" js
	JOIN "journey_runs" jr ON jr.run_id = js.run_id
	WHERE jr.category_norm <> 'Fernverkehr'
		AND (jr.operator IS NULL OR jr.operator <> 'Mainzer Mobilität')
		AND (jr.poll_state IS NULL OR jr.poll_state <> 'excluded')
		AND (js.stop_id, js.day_of_operation) IN (
			SELECT js2.stop_id, js2.day_of_operation
			FROM "journey_stops" js2
			WHERE (js2.rt_dep_time IS NOT NULL AND js2.dep_time IS NOT NULL
					AND left(js2.rt_dep_time, 2)::int - left(js2.dep_time, 2)::int NOT BETWEEN -12 AND 12)
				OR (js2.rt_arr_time IS NOT NULL AND js2.arr_time IS NOT NULL
					AND left(js2.rt_arr_time, 2)::int - left(js2.arr_time, 2)::int NOT BETWEEN -12 AND 12)
		)
	GROUP BY js.stop_id, js.day_of_operation
) agg
WHERE s.stop_id = agg.stop_id AND s.day_of_operation = agg.day_of_operation;

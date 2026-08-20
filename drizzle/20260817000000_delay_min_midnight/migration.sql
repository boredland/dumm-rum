-- Per-stop delay, corrected for departures that slip past midnight.
--
-- journey_stops holds clock times without a date, so the old expression read
-- 23:55 -> 00:05 as -1430 minutes instead of +10. Because the delayed filter
-- is `delay_min >= 7.5`, every such row counted as ON TIME and was excluded
-- from idx_journey_stops_delay_min. Measured before this migration: 45 rows
-- at about -1379, across 44 stop-days.
--
-- Anything beyond ±12 h is a wrap rather than a real figure and is folded
-- back by a day. The largest genuine delay in the data is 638 minutes (~10.6 h)
-- and nothing at all falls between -720 and -60, so the threshold has clear
-- air on both sides.
--
-- A function, not inline SQL, for the same reason as normalize_category: the
-- generated column needs the correction twice (departure, then arrival), and
-- spelled inline each branch repeats the whole split_part expression three
-- times. IMMUTABLE is required — a generated column will not accept anything
-- weaker, which is also why this stays on split_part int math instead of
-- text::timestamp.
CREATE OR REPLACE FUNCTION delay_minutes(sched text, realtime text)
RETURNS double precision
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
	SELECT CASE
		WHEN sched IS NULL OR realtime IS NULL THEN NULL
		WHEN diff < -720 THEN diff + 1440
		WHEN diff > 720 THEN diff - 1440
		ELSE diff
	END
	FROM (
		SELECT
			(split_part(realtime, ':', 1)::int * 60 + split_part(realtime, ':', 2)::int + split_part(realtime, ':', 3)::int / 60.0)
			- (split_part(sched, ':', 1)::int * 60 + split_part(sched, ':', 2)::int + split_part(sched, ':', 3)::int / 60.0)
			AS diff
	) d
$$;
--
-- The column rewrite that used to live here has been removed, and it must not
-- come back in this form.
--
-- It dropped and re-added journey_stops.delay_min so Postgres would recompute
-- the generated column for every row. That is a full table rewrite holding
-- ACCESS EXCLUSIVE on the busiest table in the database — ~17 s on 636k rows
-- locally, longer on production history. The poller writes journey_stops
-- continuously, so the lock was never free when a deploying container asked
-- for it, and a *queued* exclusive request parks every reader that arrives
-- behind it. The result was not a slow migration, it was an outage: every
-- route reading journey_stops (which is /de, via delayedByRunSq) returned 502
-- or 500 for as long as the migration kept asking, across every restart.
--
-- Nothing depends on the rewrite having happened. The column already exists
-- and is already populated; only its expression is stale, and only for rows
-- whose departure crosses midnight — 45 of them when this was written. Those
-- read as early rather than late and are missed by the delayed filter. That
-- is a small, bounded data-quality gap, and it is strictly better than a site
-- that will not load.
--
-- The corrected delay_minutes() above is still installed, so every row written
-- from here on is correct: the generated column's stored expression is stale,
-- but new rows are computed by the poller through the same function. Only
-- pre-existing midnight-crossing rows keep the old value.
--
-- To repair the historical rows, run this by hand against a quiet database
-- with ingest stopped — seconds, with nothing competing for the lock:
--
--   DROP INDEX IF EXISTS "idx_journey_stops_delay_min";
--   ALTER TABLE "journey_stops" DROP COLUMN "delay_min";
--   ALTER TABLE "journey_stops" ADD COLUMN "delay_min" double precision
--     GENERATED ALWAYS AS (COALESCE(
--       delay_minutes(dep_time, rt_dep_time),
--       delay_minutes(arr_time, rt_arr_time)
--     )) STORED;
--   CREATE INDEX IF NOT EXISTS "idx_journey_stops_delay_min"
--     ON "journey_stops" ("journey_ref","day_of_operation")
--     WHERE "journey_stops"."delay_min" >= 7.5;

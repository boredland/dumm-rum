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
$$;--> statement-breakpoint
-- The partial index reads delay_min, so it has to go before the column can be
-- dropped. Recreated below against the corrected values, which is the point:
-- the midnight rows were missing from it entirely.
DROP INDEX IF EXISTS "idx_journey_stops_delay_min";--> statement-breakpoint
-- A generated column's expression cannot be altered in place, so the column is
-- dropped and re-added. Postgres recomputes it for every existing row during
-- the ADD, which is the rewrite that repairs the historical data — no separate
-- backfill needed.
ALTER TABLE "journey_stops" DROP COLUMN "delay_min";--> statement-breakpoint
ALTER TABLE "journey_stops" ADD COLUMN "delay_min" double precision GENERATED ALWAYS AS (COALESCE(
	delay_minutes(dep_time, rt_dep_time),
	delay_minutes(arr_time, rt_arr_time)
)) STORED;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_journey_stops_delay_min" ON "journey_stops" ("journey_ref","day_of_operation") WHERE "journey_stops"."delay_min" >= 7.5;

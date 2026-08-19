-- Per-stop-day line list, so getStopSummaries stops joining raw stop visits.
--
-- The counts half of that query already reads this rollup and costs ~4 ms.
-- The lines half still went to journey_stops JOIN journey_runs and sorted
-- 493k rows down to ~2.6k distinct (stop, source:category:line) tuples,
-- spilling to disk at the default 4 MB work_mem — measured 276 ms against
-- 3.9 ms for the same answer read from here, and it is the single largest
-- term in a cold home page.
--
-- Stored as the same `source:category:line` slug `lineSlugSql` builds, so
-- the read path keeps handing whole slugs to dedupeCsv and nothing
-- downstream has to learn a second format.
ALTER TABLE "stop_day_stats" ADD COLUMN "lines" text;--> statement-breakpoint
-- Backfill every stop-day on disk in one pass, mirroring the table's
-- original backfill.
--
-- COLLECTED_TRAFFIC and the journey_ref source test are inlined rather than
-- referenced: these have to keep matching queries.ts, and a migration
-- cannot import them.
WITH agg AS (
	SELECT
		js.stop_id,
		js.day_of_operation,
		STRING_AGG(DISTINCT
			(CASE WHEN jr.journey_ref ~ '^[12]\|' THEN 'rmv' ELSE 'unknown' END)
			|| ':' || jr.category_norm || ':' || jr.line,
			','
		) AS lines
	FROM journey_stops js
	JOIN journey_runs jr
		ON jr.journey_ref = js.journey_ref
		AND jr.day_of_operation = js.day_of_operation
	WHERE jr.category_norm <> 'Fernverkehr'
		AND (jr.operator IS NULL OR jr.operator <> 'Mainzer Mobilität')
		AND (jr.poll_state IS NULL OR jr.poll_state <> 'excluded')
	GROUP BY js.stop_id, js.day_of_operation
)
UPDATE stop_day_stats sds
SET lines = agg.lines
FROM agg
WHERE sds.stop_id = agg.stop_id
	AND sds.day_of_operation = agg.day_of_operation;

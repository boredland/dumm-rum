CREATE TABLE "stop_day_stats" (
	"stop_id" text,
	"day_of_operation" text,
	"stop_name" text NOT NULL,
	"total" integer DEFAULT 0 NOT NULL,
	"cancelled" integer DEFAULT 0 NOT NULL,
	"ghost" integer DEFAULT 0 NOT NULL,
	"delayed" integer DEFAULT 0 NOT NULL,
	"last_change" text,
	"categories" text,
	CONSTRAINT "stop_day_stats_pkey" PRIMARY KEY("stop_id","day_of_operation")
);
--> statement-breakpoint
CREATE INDEX "idx_stop_day_stats_day" ON "stop_day_stats" ("day_of_operation");--> statement-breakpoint
-- Backfill every stop-day already on disk. One pass over journey_stops
-- joined to journey_runs — the same aggregate getStopStats used to run per
-- request, paid once here instead.
--
-- COLLECTED_TRAFFIC is inlined rather than referenced: this has to keep
-- matching the filter in queries.ts, and a migration cannot import it.
-- Long-distance and Mainz rows are no longer ingested, so in practice this
-- only excludes historical rows the site already hides.
INSERT INTO stop_day_stats (
	stop_id, day_of_operation, stop_name, total, cancelled, ghost, delayed,
	last_change, categories
)
SELECT
	js.stop_id,
	js.day_of_operation,
	MIN(js.stop_name),
	COUNT(*),
	SUM(CASE WHEN js.cancelled THEN 1 ELSE 0 END),
	SUM(CASE WHEN NOT jr.was_tracked AND NOT jr.cancelled THEN 1 ELSE 0 END),
	SUM(CASE WHEN NOT js.cancelled AND js.delay_min >= 7.5 THEN 1 ELSE 0 END),
	MAX(jr.snapshot_at),
	STRING_AGG(DISTINCT jr.category_norm, ',' ORDER BY jr.category_norm)
FROM journey_stops js
JOIN journey_runs jr
	ON jr.journey_ref = js.journey_ref
	AND jr.day_of_operation = js.day_of_operation
WHERE jr.category_norm <> 'Fernverkehr'
	AND (jr.operator IS NULL OR jr.operator <> 'Mainzer Mobilität')
	AND (jr.poll_state IS NULL OR jr.poll_state <> 'excluded')
GROUP BY js.stop_id, js.day_of_operation
ON CONFLICT (stop_id, day_of_operation) DO UPDATE SET
	stop_name = EXCLUDED.stop_name,
	total = EXCLUDED.total,
	cancelled = EXCLUDED.cancelled,
	ghost = EXCLUDED.ghost,
	delayed = EXCLUDED.delayed,
	last_change = EXCLUDED.last_change,
	categories = EXCLUDED.categories;

-- Single source of truth for HAFAS category -> display bucket.
-- Previously this CASE was copy-pasted into normalizedCategorySql, the
-- getStopSummaries CTE, a TS mirror on the home page, and a fourth list
-- for icon selection, and they had drifted: the CTE knew no long names
-- and had no Regionalverkehr/Bus/Tram branches at all, so the same run
-- normalized differently depending on which query answered.
--
-- Takes NULL (rather than RETURNS NULL ON NULL INPUT) so callers never
-- need a COALESCE wrapper — a wrapped call would not match the
-- functional index below and would seq-scan journey_runs.
--
-- NOTE: \y, not \b — in Postgres regexes \b means backspace, so the old
-- '^(RB|RE|IRE)\b' branch never matched and every RB/RE run leaked
-- through as its raw category.
CREATE OR REPLACE FUNCTION normalize_category(category text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
	SELECT CASE
		WHEN category IS NULL THEN 'Bus'
		WHEN category IN ('ICE', 'ICE-Sprinter', 'IC', 'EC', 'ECE', 'NJ', 'EN', 'RJ', 'RJX', 'TGV', 'EST', 'Fernverkehr', 'Intercity-Express', 'Intercity', 'Eurocity', 'Nightjet', 'Railjet', 'Railjet Xpress', 'D-Zug', 'Fernzug')
			OR category ~ '^(ICE|IC|EC|ECE|NJ|EN|RJ|RJX|TGV|EST)\y' THEN 'Fernverkehr'
		WHEN category IN ('Regional-Bahn', 'Regionalbahn', 'R-Bahn', 'R', 'Regionalverkehr')
			OR category ~ '^(RB|RE|IRE)\y' THEN 'Regionalverkehr'
		WHEN category IN ('S', 'S-Bahn') THEN 'S-Bahn'
		WHEN category = 'U-Bahn' THEN 'U-Bahn'
		WHEN category IN ('Str', 'Straßenbahn', 'Hochflurstraßenbahn', 'Niederflurstraßenbahn')
			OR category ~* 'stra(ß|ss)enbahn' THEN 'Tram'
		WHEN category IN ('AST', 'Stadtbus', 'Regionalbus', 'Schnellbus', 'Niederflurbus')
			OR category ~* 'bus$' THEN 'Bus'
		ELSE category
	END
$$;--> statement-breakpoint
-- Not CONCURRENTLY: drizzle's migrate() wraps every migration in one
-- transaction, which forbids it. journey_runs is the small table (runs,
-- not per-stop visits), and ingest writes are retried poll jobs, so the
-- brief build-time lock is acceptable.
CREATE INDEX IF NOT EXISTS "idx_journey_runs_normalized_category" ON "journey_runs" (normalize_category("category"));--> statement-breakpoint
-- Existing subscriptions store `source:category:line` slugs built from the
-- raw category. The picker and the alert path both emit buckets now, so
-- un-migrated rows would silently stop matching any alert.
UPDATE "telegram_subscriptions"
SET "line" = split_part("line", ':', 1)
	|| ':' || normalize_category(split_part("line", ':', 2))
	|| ':' || substring("line" from '^[^:]*:[^:]*:(.*)$')
WHERE "line" ~ '^[^:]*:[^:]*:.*$'
	AND normalize_category(split_part("line", ':', 2)) <> split_part("line", ':', 2);

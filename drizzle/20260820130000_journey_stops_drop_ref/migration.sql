-- Removes journey_ref from journey_stops, and the indexes that led with it.
--
-- Deliberately a second migration, one deploy behind
-- 20260820120000_journey_stops_run_id. That one is additive, so the old and
-- new containers can both run against it during the start-first overlap. This
-- one is destructive to the old shape, and is only safe once every container
-- still reading journey_ref is gone — which is true by the time the next
-- deploy runs.
--
-- Do not merge the two. The overlap is not hypothetical: rehearsal had a
-- concurrently running old-shape writer die on `column "journey_ref" does not
-- exist` the instant these statements landed.
--
-- Catalog-only, like the first: dropping an index unlinks its files, and
-- DROP COLUMN marks the attribute dead without rewriting the heap. Measured
-- under concurrent write load, no statement exceeded 9 ms.

-- The transition trigger scripts/backfill-run-id.ts installs, which kept the
-- old poller's inserts from landing with a NULL run_id while the backfill ran.
-- It dereferences NEW.journey_ref, so it must go before that column does. The
-- deploy carrying this migration also carries the poller that writes run_id
-- itself, so nothing needs it afterwards.
DROP TRIGGER IF EXISTS "journey_stops_fill_run_id" ON "journey_stops";--> statement-breakpoint
DROP FUNCTION IF EXISTS journey_stops_fill_run_id();--> statement-breakpoint
-- Finally the column itself, ~172 of the ~326 bytes per row. Also catalog-only:
-- Postgres marks the attribute dropped and leaves the bytes in place, so the
-- heap shrinks as rows are rewritten by ordinary churn rather than all at once.
ALTER TABLE "journey_stops" DROP COLUMN "journey_ref";--> statement-breakpoint
-- Match the names schema.ts declares, so a later `drizzle-kit generate` does
-- not plan to recreate what the script already built.
ALTER INDEX "idx_journey_stops_delay_min_run" RENAME TO "idx_journey_stops_delay_min";--> statement-breakpoint
ALTER INDEX "idx_journey_stops_origin_rt_run" RENAME TO "idx_journey_stops_origin_rt";--> statement-breakpoint
ALTER INDEX "idx_journey_stops_run_name" RENAME TO "idx_journey_stops_ref_day_name";

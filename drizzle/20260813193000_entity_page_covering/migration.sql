-- Covering indexes for the line and operator detail pages.
--
-- getLineStats and getOperatorStats read every run an entity has ever had
-- — deliberately, because those pages plot the full per-day history and
-- bounding them would remove data users can see. A busy operator is ~338k
-- runs in production, and each one carries an EXISTS probe into
-- journey_stops for the delayed count, so the pages cost 3.7-4.5 s on a
-- cold memo key while the rest of the site sits at 0.2-0.4 s.
--
-- The existing (operator, day) and (line, day) indexes locate the rows but
-- carry no payload, so every run still needed a heap fetch. Adding the
-- columns both queries read turns the scan index-only:
--   operator page: 34 ms -> 13 ms, Heap Fetches 0
--   line page:     26 ms ->  1 ms, Heap Fetches 0
-- measured locally; the gap widens with run count, which is what hurts in
-- production.
--
-- These supplement rather than replace idx_journey_runs_line /
-- idx_journey_runs_operator: those stay the cheap lookup path for queries
-- that do not need the payload. Both new indexes are ~6 MB locally.
--
-- Hand-written because this drizzle version's index builder has no
-- .include(); see the note in schema.ts.
CREATE INDEX IF NOT EXISTS idx_journey_runs_operator_cover
	ON journey_runs (operator, day_of_operation)
	INCLUDE (journey_ref, cancelled, was_tracked, category_norm, poll_state);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_journey_runs_line_cover
	ON journey_runs (line, day_of_operation)
	INCLUDE (journey_ref, cancelled, was_tracked, category_norm, poll_state, operator, dest_name);

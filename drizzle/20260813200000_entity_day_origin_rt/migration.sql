-- Covering index for the origin realtime-departure lookup on the entity
-- day pages.
--
-- getLineDayJourneys and getOperatorDayJourneys both carry a correlated
-- subquery that reads one column — rt_dep_time at route_idx 0 — for every
-- run they list. The journey_stops primary key locates that row, but has
-- no payload, so each of the ~2.3k runs on a busy operator-day cost a heap
-- fetch: 11330 shared buffer hits inside the subquery alone. Fresh
-- operator-day keys measured 1.5-5.0 s against production.
--
-- Partial on route_idx = 0, which is what the subquery filters on, so the
-- index holds one row per run rather than one per stop visit — 5 MB
-- locally against journey_stops' 350 MB. INCLUDE (rt_dep_time) makes the
-- probe index-only: 19 ms -> 8 ms, Heap Fetches 11330 -> 0.
--
-- Hand-written because this drizzle version's index builder has no
-- .include(); see the note in schema.ts.
CREATE INDEX IF NOT EXISTS idx_journey_stops_origin_rt
	ON journey_stops (journey_ref, day_of_operation)
	INCLUDE (rt_dep_time)
	WHERE route_idx = 0;

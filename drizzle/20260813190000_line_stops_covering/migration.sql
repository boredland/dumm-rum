-- Covering index for the line -> stop-name fan-out behind the subscribe
-- modal's pick-lists.
--
-- getStopsForLine walks every run of a line into its stop visits and
-- returns the ~40 distinct stop names. On a busy tram line that is ~20k
-- stop rows in the 30-day window locally, and journey_stops is ~56x larger
-- in production, so the fan-out was costing 1.2-6.8 s on a cold memo key —
-- long enough that the modal's Haltestelle dropdown sat empty after a line
-- was picked.
--
-- Carrying stop_name as an INCLUDE payload turns the per-run probe into an
-- index-only scan: 83 ms -> 11 ms locally, Heap Fetches 16106 -> 8 once the
-- visibility map is warm.
--
-- Written by hand rather than generated: this drizzle version's index
-- builder has no .include(), so a declared version would lose the payload
-- and every later `generate` would plan to drop and recreate it.
CREATE INDEX IF NOT EXISTS idx_journey_stops_ref_day_name
	ON journey_stops (journey_ref, day_of_operation) INCLUDE (stop_name);

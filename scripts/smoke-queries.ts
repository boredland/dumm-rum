/** Exercises the real query layer against a migrated database, so the
 * surrogate-key rewrite is proven through the exported functions rather than
 * hand-written SQL. Seeds a small dataset in the new shape first. */
import { sql as pg } from "../src/db/client.ts";
import {
	getLineSummaries,
	getOperatorSummaries,
	getStopDayDepartures,
	getStopStats,
	getStopSummaries,
} from "../src/lib/queries.ts";

const DAY = "2026-08-12";

await pg`
	INSERT INTO journey_runs (
		journey_ref, run_id, day_of_operation, line, category, operator,
		origin_stop_id, origin_name, origin_dep_time,
		dest_stop_id, dest_name, dest_arr_time, was_tracked, poll_state, snapshot_at
	)
	SELECT '#VN#1#ST#1784051499#PI#0#ZI#' || g || '#TA#19#DA#150726#1S#3000118#',
		g, ${DAY}, 'Bus ' || (g % 5), 'Bus', 'In-der-City-Bus',
		'3000118', 'Start', '08:00:00', '3000228', 'Ende', '08:45:00',
		true, 'done', now()::text
	FROM generate_series(1, 50) g
	ON CONFLICT DO NOTHING
`;

await pg`
	INSERT INTO journey_stops (
		run_id, day_of_operation, route_idx, stop_id, stop_name,
		dep_time, rt_dep_time
	)
	SELECT r.run_id, r.day_of_operation, s,
		'300' || lpad((s % 10)::text, 4, '0'), 'Halt ' || (s % 10),
		'08:' || lpad((s * 2)::text, 2, '0') || ':00',
		CASE WHEN s % 4 = 0
			THEN '08:' || lpad((s * 2 + 12)::text, 2, '0') || ':00' ELSE NULL END
	FROM journey_runs r, generate_series(0, 20) s
	ON CONFLICT DO NOTHING
`;

await pg`
	INSERT INTO known_stops (stop_id, stop_name, slug)
	SELECT DISTINCT stop_id, stop_name, 'halt-' || right(stop_id, 1)
	FROM journey_stops ON CONFLICT DO NOTHING
`;

// stop_day_stats is a write-time rollup; the read paths for the home page and
// station pages come from it, so it has to exist for those to return anything.
await pg`
	INSERT INTO stop_day_stats (
		stop_id, day_of_operation, stop_name, total, cancelled, ghost, delayed,
		last_change, categories, lines
	)
	SELECT js.stop_id, js.day_of_operation, min(js.stop_name),
		count(*)::int, 0, 0,
		sum(CASE WHEN js.delay_min >= 7.5 THEN 1 ELSE 0 END)::int,
		max(jr.snapshot_at), 'Bus', 'rmv:Bus:' || min(jr.line)
	FROM journey_stops js JOIN journey_runs jr ON jr.run_id = js.run_id
	GROUP BY js.stop_id, js.day_of_operation
	ON CONFLICT DO NOTHING
`;

const stopIds = (
	await pg<{ stop_id: string }[]>`SELECT DISTINCT stop_id FROM journey_stops`
).map((r) => r.stop_id);

const departures = await getStopDayDepartures(stopIds.slice(0, 3), DAY);
console.log(`getStopDayDepartures: ${departures.length} rows`);
if (departures.length === 0) throw new Error("no departures returned");
const first = departures[0];
if (!first.journeyRef.startsWith("#VN#"))
	throw new Error(`journeyRef not preserved: ${first.journeyRef}`);
console.log(`  journeyRef preserved: ${first.journeyRef.slice(0, 28)}…`);
console.log(
	`  routeIdx=${first.routeIdx} line=${first.line} time=${first.time}`,
);

const ops = await getOperatorSummaries({ days: "all" });
console.log(`getOperatorSummaries: ${ops.length} operator(s)`);
if (ops.length === 0) throw new Error("no operator summaries");
console.log(
	`  ${ops[0].operator}: total=${ops[0].total} delayed=${ops[0].delayed}`,
);
if (ops[0].delayed === 0)
	throw new Error("delayed count is 0 — join is broken");

const lines = await getLineSummaries({ days: "all" });
console.log(`getLineSummaries: ${lines.length} line(s)`);
if (lines.length === 0) throw new Error("no line summaries");

const stats = await getStopStats(stopIds.slice(0, 1));
console.log(`getStopStats: ${stats.days.length} day(s)`);

const summaries = await getStopSummaries();
console.log(`getStopSummaries: ${summaries.length} stop(s)`);

console.log("\nALL QUERY PATHS OK");
await pg.end({ timeout: 5 });

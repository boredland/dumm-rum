/** Simulates the currently-deployed poller: inserts journey_stops rows with
 * journey_ref and no run_id, the way the old code does, so the migration
 * rehearsal faces the same race production will. Runs until killed. */
import postgres from "postgres";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not set");
const sql = postgres(url, { max: 1 });

let n = 0;
const day = "2026-08-13";
for (;;) {
	const ref = `#VN#1#ST#178405999#PI#0#ZI#live${n}#TA#19#DA#150726#1S#3000118#`;
	await sql`
		INSERT INTO journey_runs (
			journey_ref, run_id, day_of_operation, line, category, operator,
			origin_stop_id, origin_name, origin_dep_time,
			dest_stop_id, dest_name, dest_arr_time, was_tracked, snapshot_at
		) VALUES (
			${ref}, ${900000 + n}, ${day}, 'Bus live', 'Bus', 'In-der-City-Bus',
			'3000118', 'Start', '09:00:00', '3000228', 'Ende', '09:45:00',
			true, now()::text
		) ON CONFLICT DO NOTHING
	`;
	// The old poller's shape: no run_id in the column list.
	await sql`
		INSERT INTO journey_stops (
			journey_ref, day_of_operation, route_idx, stop_id, stop_name, dep_time
		) VALUES (
			${ref}, ${day}, 0, '3000118', 'Start', '09:00:00'
		) ON CONFLICT DO NOTHING
	`;
	n++;
	const { promise, resolve } = Promise.withResolvers<void>();
	setTimeout(resolve, 150);
	await promise;
}

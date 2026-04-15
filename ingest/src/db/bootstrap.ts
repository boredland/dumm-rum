import type postgres from "postgres";

const DDL = `
CREATE TABLE IF NOT EXISTS journey_runs (
	journey_ref TEXT NOT NULL,
	day_of_operation TEXT NOT NULL,
	line TEXT NOT NULL,
	category TEXT,
	operator TEXT,
	origin_stop_id TEXT NOT NULL,
	origin_name TEXT NOT NULL,
	origin_dep_time TEXT NOT NULL,
	dest_stop_id TEXT NOT NULL,
	dest_name TEXT NOT NULL,
	dest_arr_time TEXT NOT NULL,
	status TEXT NOT NULL,
	cancelled BOOLEAN NOT NULL DEFAULT FALSE,
	part_cancelled BOOLEAN NOT NULL DEFAULT FALSE,
	cancelled_stop_count INTEGER NOT NULL DEFAULT 0,
	total_stop_count INTEGER NOT NULL,
	was_tracked BOOLEAN NOT NULL DEFAULT FALSE,
	poll_state TEXT,
	polyline TEXT,
	snapshot_at TEXT NOT NULL,
	PRIMARY KEY (journey_ref, day_of_operation)
);
CREATE INDEX IF NOT EXISTS idx_journey_runs_day ON journey_runs (day_of_operation);
CREATE INDEX IF NOT EXISTS idx_journey_runs_poll_state ON journey_runs (poll_state, day_of_operation);

CREATE TABLE IF NOT EXISTS journey_stops (
	journey_ref TEXT NOT NULL,
	day_of_operation TEXT NOT NULL,
	route_idx INTEGER NOT NULL,
	stop_id TEXT NOT NULL,
	stop_name TEXT NOT NULL,
	dep_time TEXT,
	arr_time TEXT,
	rt_dep_time TEXT,
	rt_arr_time TEXT,
	cancelled BOOLEAN NOT NULL DEFAULT FALSE,
	lat REAL,
	lon REAL,
	PRIMARY KEY (journey_ref, day_of_operation, route_idx)
);
CREATE INDEX IF NOT EXISTS idx_journey_stops_day ON journey_stops (day_of_operation);

CREATE TABLE IF NOT EXISTS journey_positions (
	id SERIAL PRIMARY KEY,
	journey_ref TEXT NOT NULL,
	day_of_operation TEXT NOT NULL,
	lat REAL NOT NULL,
	lon REAL NOT NULL,
	reported_at TEXT NOT NULL,
	route_idx INTEGER,
	rt_route_idx INTEGER,
	captured_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_journey_pos_ref_day ON journey_positions (journey_ref, day_of_operation);
CREATE INDEX IF NOT EXISTS idx_journey_pos_captured ON journey_positions (captured_at);
`;

export async function bootstrap(sql: postgres.Sql): Promise<void> {
	await sql.unsafe(DDL);
}

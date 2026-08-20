-- A database in production's pre-migration shape, with data, for exercising
-- scripts/backfill-run-id.ts before it is pointed at production.
CREATE OR REPLACE FUNCTION normalize_category(cat text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$ SELECT COALESCE(cat, 'Bus') $$;

CREATE OR REPLACE FUNCTION delay_minutes(sched text, realtime text)
RETURNS double precision LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
	SELECT CASE
		WHEN sched IS NULL OR realtime IS NULL THEN NULL
		WHEN diff < -720 THEN diff + 1440
		WHEN diff > 720 THEN diff - 1440
		ELSE diff
	END
	FROM (
		SELECT
			(split_part(realtime, ':', 1)::int * 60 + split_part(realtime, ':', 2)::int + split_part(realtime, ':', 3)::int / 60.0)
			- (split_part(sched, ':', 1)::int * 60 + split_part(sched, ':', 2)::int + split_part(sched, ':', 3)::int / 60.0)
			AS diff
	) d
$$;

CREATE TABLE journey_runs (
	journey_ref text NOT NULL,
	run_id integer NOT NULL,
	day_of_operation text NOT NULL,
	line text NOT NULL,
	category text,
	operator text,
	origin_stop_id text NOT NULL,
	origin_name text NOT NULL,
	origin_dep_time text NOT NULL,
	dest_stop_id text NOT NULL,
	dest_name text NOT NULL,
	dest_arr_time text NOT NULL,
	cancelled boolean NOT NULL DEFAULT false,
	was_tracked boolean NOT NULL DEFAULT false,
	poll_state text,
	snapshot_at text NOT NULL,
	category_norm text GENERATED ALWAYS AS (normalize_category(category)) STORED,
	PRIMARY KEY (journey_ref, day_of_operation)
);
CREATE UNIQUE INDEX journey_runs_run_id_idx ON journey_runs (run_id);

-- Pre-migration journey_stops: keyed on the raw ref, no run_id.
CREATE TABLE journey_stops (
	journey_ref text NOT NULL,
	day_of_operation text NOT NULL,
	route_idx integer NOT NULL,
	stop_id text NOT NULL,
	stop_name text NOT NULL,
	dep_time text,
	arr_time text,
	rt_dep_time text,
	rt_arr_time text,
	cancelled boolean NOT NULL DEFAULT false,
	delay_min double precision GENERATED ALWAYS AS (COALESCE(
		delay_minutes(dep_time, rt_dep_time),
		delay_minutes(arr_time, rt_arr_time)
	)) STORED,
	PRIMARY KEY (journey_ref, day_of_operation, route_idx)
);
CREATE INDEX idx_journey_stops_stop_day ON journey_stops (stop_id, day_of_operation);
CREATE INDEX idx_journey_stops_day_name ON journey_stops (day_of_operation, stop_name);
CREATE INDEX idx_journey_stops_ref_day_name ON journey_stops (journey_ref, day_of_operation) INCLUDE (stop_name);
CREATE INDEX idx_journey_stops_origin_rt ON journey_stops (journey_ref, day_of_operation) INCLUDE (rt_dep_time) WHERE route_idx = 0;
CREATE INDEX idx_journey_stops_delay_min ON journey_stops (journey_ref, day_of_operation) WHERE delay_min >= 7.5;

-- 3 days x 400 runs x 21 stops, with refs shaped like the real HAFAS blobs.
INSERT INTO journey_runs (
	journey_ref, run_id, day_of_operation, line, category, operator,
	origin_stop_id, origin_name, origin_dep_time,
	dest_stop_id, dest_name, dest_arr_time, was_tracked, snapshot_at
)
SELECT
	'#VN#1#ST#178405' || g || '#PI#0#ZI#' || g || '#TA#19#DA#' || d || '#1S#3000118#1T#' || g || '#LS#3000228#',
	row_number() OVER (),
	'2026-08-' || lpad((10 + d)::text, 2, '0'),
	'Bus ' || (g % 40), 'Bus', 'In-der-City-Bus',
	'3000118', 'Start', '08:00:00', '3000228', 'Ende', '08:45:00', true, now()::text
FROM generate_series(1, 400) g, generate_series(1, 3) d;

INSERT INTO journey_stops (
	journey_ref, day_of_operation, route_idx, stop_id, stop_name,
	dep_time, arr_time, rt_dep_time, rt_arr_time
)
SELECT
	r.journey_ref, r.day_of_operation, s,
	'300' || lpad((s * 7 % 60)::text, 4, '0'),
	'Halt ' || (s * 7 % 60),
	lpad((8 + s / 4)::text, 2, '0') || ':' || lpad((s * 3 % 60)::text, 2, '0') || ':00',
	NULL,
	-- every 9th stop late enough to land in the partial delay index
	CASE WHEN s % 9 = 0
		THEN lpad((8 + s / 4)::text, 2, '0') || ':' || lpad((s * 3 % 60 + 11)::text, 2, '0') || ':00'
		ELSE NULL END,
	NULL
FROM journey_runs r, generate_series(0, 20) s;

-- One midnight-crossing pair: the stale delay_min case the corrected
-- delay_minutes() is supposed to fix on rewrite.
INSERT INTO journey_stops (
	journey_ref, day_of_operation, route_idx, stop_id, stop_name,
	dep_time, arr_time, rt_dep_time, rt_arr_time
)
SELECT journey_ref, day_of_operation, 99, '3009999', 'Mitternacht',
	'23:55:00', NULL, '00:05:00', NULL
FROM journey_runs LIMIT 5;

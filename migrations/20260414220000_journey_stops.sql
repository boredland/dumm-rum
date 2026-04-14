CREATE TABLE journey_stops (
  journey_ref TEXT NOT NULL,
  day_of_operation TEXT NOT NULL,
  route_idx INTEGER NOT NULL,
  stop_id TEXT NOT NULL,
  stop_name TEXT NOT NULL,
  dep_time TEXT,
  arr_time TEXT,
  rt_dep_time TEXT,
  rt_arr_time TEXT,
  cancelled INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (journey_ref, day_of_operation, route_idx)
);

CREATE INDEX idx_journey_stops_stop_day ON journey_stops (stop_id, day_of_operation);
CREATE INDEX idx_journey_stops_day ON journey_stops (day_of_operation);

CREATE TABLE known_stops (
  stop_id TEXT PRIMARY KEY,
  stop_name TEXT NOT NULL,
  lines TEXT,
  categories TEXT,
  journey_count INTEGER NOT NULL DEFAULT 0,
  cancelled INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

-- Backfill from departures: one row per (journey_ref, date, station).
-- route_idx is unknown from departure data, so use a synthetic one via ROW_NUMBER.
-- rt times and cancellation are preserved from the departure data.
INSERT OR IGNORE INTO journey_stops (journey_ref, day_of_operation, route_idx, stop_id, stop_name, dep_time, arr_time, rt_dep_time, rt_arr_time, cancelled)
SELECT
  d.journey_ref,
  d.date,
  ROW_NUMBER() OVER (PARTITION BY d.journey_ref, d.date ORDER BY d.time) - 1,
  d.station_id,
  COALESCE(d.stop, d.station_id),
  d.time,
  d.time,
  d.rt_time,
  d.rt_time,
  d.cancelled
FROM departures d
WHERE d.journey_ref IS NOT NULL;

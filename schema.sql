CREATE TABLE IF NOT EXISTS departures (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  station_id     TEXT NOT NULL,
  date           TEXT NOT NULL,
  time           TEXT NOT NULL,
  rt_date        TEXT,
  rt_time        TEXT,
  line           TEXT NOT NULL,
  direction      TEXT NOT NULL,
  journey_status TEXT NOT NULL DEFAULT 'P',
  cancelled      INTEGER NOT NULL DEFAULT 0,
  operator       TEXT,
  category       TEXT,
  journey_num    TEXT NOT NULL,
  reachable      INTEGER,
  stop           TEXT,
  stop_ext_id    TEXT,
  fetched_at     TEXT NOT NULL,
  UNIQUE(station_id, date, time, line, direction, journey_num)
);

CREATE TABLE IF NOT EXISTS haikus (
  date       TEXT NOT NULL,
  station_id TEXT NOT NULL,
  haiku      TEXT NOT NULL,
  PRIMARY KEY (date, station_id)
);

CREATE INDEX IF NOT EXISTS idx_departures_station_date ON departures(station_id, date);
CREATE INDEX IF NOT EXISTS idx_departures_next ON departures(station_id, date, cancelled, time);
CREATE INDEX IF NOT EXISTS idx_departures_fetched ON departures(fetched_at);

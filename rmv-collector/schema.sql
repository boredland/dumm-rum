CREATE TABLE IF NOT EXISTS departures (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  date           TEXT NOT NULL,
  time           TEXT NOT NULL,
  rt_date        TEXT,
  rt_time        TEXT,
  line           TEXT NOT NULL,
  direction      TEXT NOT NULL,
  journey_status TEXT NOT NULL DEFAULT 'P',
  operator       TEXT,
  category       TEXT,
  journey_num    TEXT NOT NULL,
  reachable      INTEGER,
  stop           TEXT,
  stop_ext_id    TEXT,
  fetched_at     TEXT NOT NULL,
  UNIQUE(date, time, line, direction, journey_num)
);

CREATE INDEX IF NOT EXISTS idx_departures_date ON departures(date);
CREATE INDEX IF NOT EXISTS idx_departures_status ON departures(date, journey_status);

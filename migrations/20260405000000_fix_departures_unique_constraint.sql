-- The ALTER TABLE DROP COLUMN rebuilt the table with a legacy 5-column unique
-- constraint missing station_id. Rebuild the table with the correct constraint.
CREATE TABLE departures_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  station_id TEXT NOT NULL,
  date TEXT NOT NULL,
  time TEXT NOT NULL,
  rt_date TEXT,
  rt_time TEXT,
  line TEXT NOT NULL,
  direction TEXT NOT NULL,
  cancelled INTEGER NOT NULL DEFAULT 0,
  operator TEXT,
  category TEXT,
  journey_num TEXT NOT NULL,
  stop TEXT,
  notified INTEGER NOT NULL DEFAULT 0,
  fetched_at TEXT NOT NULL,
  UNIQUE(station_id, date, time, line, direction, journey_num)
);

INSERT INTO departures_new (id, station_id, date, time, rt_date, rt_time, line, direction, cancelled, operator, category, journey_num, stop, notified, fetched_at)
  SELECT id, station_id, date, time, rt_date, rt_time, line, direction, cancelled, operator, category, journey_num, stop, notified, fetched_at FROM departures;

DROP TABLE departures;
ALTER TABLE departures_new RENAME TO departures;

-- Recreate all indexes
CREATE INDEX idx_departures_station_date ON departures(station_id, date);
CREATE INDEX idx_departures_station_fetched ON departures(station_id, fetched_at);
CREATE INDEX idx_departures_operator_date ON departures(operator, date);
CREATE INDEX idx_departures_date ON departures(date);
CREATE INDEX idx_departures_line_date ON departures(line, date);
CREATE INDEX idx_departures_date_notified ON departures(date, notified);

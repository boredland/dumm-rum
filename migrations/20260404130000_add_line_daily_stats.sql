CREATE TABLE IF NOT EXISTS line_daily_stats (
  line TEXT NOT NULL,
  date TEXT NOT NULL,
  total INTEGER NOT NULL DEFAULT 0,
  cancelled INTEGER NOT NULL DEFAULT 0,
  delayed INTEGER NOT NULL DEFAULT 0,
  avg_delay REAL,
  category TEXT,
  operators TEXT,
  destinations TEXT,
  PRIMARY KEY (line, date)
);
CREATE INDEX IF NOT EXISTS idx_line_daily_stats_date ON line_daily_stats (date);

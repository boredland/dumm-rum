-- Remove night/sleeper line departures (lines ending with N like 12N)
DELETE FROM departures WHERE line LIKE '%N' AND line GLOB '*[0-9]N';

-- Rebuild station_daily_stats from remaining departures
DELETE FROM station_daily_stats;
INSERT INTO station_daily_stats (station_id, date, total, cancelled, delayed, avg_delay)
SELECT
  station_id,
  date,
  COUNT(*) AS total,
  SUM(cancelled) AS cancelled,
  SUM(CASE WHEN cancelled = 0 AND rt_time IS NOT NULL AND (strftime('%s', rt_date || ' ' || rt_time) - strftime('%s', date || ' ' || time)) / 60.0 >= 7.5 THEN 1 ELSE 0 END) AS delayed,
  AVG(CASE WHEN cancelled = 0 AND rt_time IS NOT NULL THEN (strftime('%s', rt_date || ' ' || rt_time) - strftime('%s', date || ' ' || time)) / 60.0 END) AS avg_delay
FROM departures
GROUP BY station_id, date;

-- Rebuild operator_daily_stats from remaining departures
DELETE FROM operator_daily_stats;
INSERT INTO operator_daily_stats (operator, date, total, cancelled, delayed, avg_delay)
SELECT
  operator,
  date,
  COUNT(*) AS total,
  SUM(cancelled) AS cancelled,
  SUM(CASE WHEN cancelled = 0 AND rt_time IS NOT NULL AND (strftime('%s', rt_date || ' ' || rt_time) - strftime('%s', date || ' ' || time)) / 60.0 >= 7.5 THEN 1 ELSE 0 END) AS delayed,
  AVG(CASE WHEN cancelled = 0 AND rt_time IS NOT NULL THEN (strftime('%s', rt_date || ' ' || rt_time) - strftime('%s', date || ' ' || time)) / 60.0 END) AS avg_delay
FROM departures
WHERE operator IS NOT NULL
GROUP BY operator, date;

DELETE FROM departures WHERE station_id = '3006903' AND category = 'Bus';--> statement-breakpoint

DELETE FROM station_daily_stats WHERE station_id = '3006903';--> statement-breakpoint

INSERT INTO station_daily_stats (station_id, date, total, cancelled, delayed, avg_delay)
SELECT
  station_id,
  date,
  COUNT(*) AS total,
  SUM(cancelled) AS cancelled,
  SUM(CASE WHEN cancelled = 0 AND rt_time IS NOT NULL AND (strftime('%s', rt_date || ' ' || rt_time) - strftime('%s', date || ' ' || time)) / 60.0 >= 7.5 THEN 1 ELSE 0 END) AS delayed,
  AVG(CASE WHEN cancelled = 1 THEN 15 WHEN rt_time IS NOT NULL THEN MIN((strftime('%s', rt_date || ' ' || rt_time) - strftime('%s', date || ' ' || time)) / 60.0, 15) END) AS avg_delay
FROM departures
WHERE station_id = '3006903'
GROUP BY station_id, date;--> statement-breakpoint

DELETE FROM operator_daily_stats;--> statement-breakpoint

INSERT INTO operator_daily_stats (operator, date, total, cancelled, delayed, avg_delay)
SELECT
  operator,
  date,
  COUNT(DISTINCT journey_num) AS total,
  COUNT(DISTINCT CASE WHEN cancelled = 1 THEN journey_num END) AS cancelled,
  COUNT(DISTINCT CASE WHEN cancelled = 0 AND rt_time IS NOT NULL AND (strftime('%s', rt_date || ' ' || rt_time) - strftime('%s', date || ' ' || time)) / 60.0 >= 7.5 THEN journey_num END) AS delayed,
  AVG(CASE WHEN cancelled = 1 THEN 15 WHEN rt_time IS NOT NULL THEN MIN((strftime('%s', rt_date || ' ' || rt_time) - strftime('%s', date || ' ' || time)) / 60.0, 15) END) AS avg_delay
FROM departures
WHERE operator IS NOT NULL
GROUP BY operator, date;

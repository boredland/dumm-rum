DELETE FROM operator_daily_stats;--> statement-breakpoint

INSERT INTO operator_daily_stats (operator, date, total, cancelled, delayed, avg_delay)
SELECT
  operator,
  date,
  COUNT(DISTINCT journey_num) AS total,
  COUNT(DISTINCT CASE WHEN cancelled = 1 THEN journey_num END) AS cancelled,
  COUNT(DISTINCT CASE WHEN cancelled = 0 AND rt_time IS NOT NULL AND (strftime('%s', rt_date || ' ' || rt_time) - strftime('%s', date || ' ' || time)) / 60.0 >= 7.5 THEN journey_num END) AS delayed,
  AVG(CASE WHEN cancelled = 1 THEN 15 WHEN rt_time IS NOT NULL THEN (strftime('%s', rt_date || ' ' || rt_time) - strftime('%s', date || ' ' || time)) / 60.0 END) AS avg_delay
FROM departures
WHERE operator IS NOT NULL
GROUP BY operator, date;

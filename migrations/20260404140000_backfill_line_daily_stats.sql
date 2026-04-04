INSERT OR REPLACE INTO line_daily_stats (line, date, total, cancelled, delayed, avg_delay, category, operators, destinations)
SELECT
  line,
  date,
  COUNT(DISTINCT journey_num) AS total,
  COUNT(DISTINCT CASE WHEN cancelled = 1 THEN journey_num END) AS cancelled,
  COUNT(DISTINCT CASE WHEN cancelled = 0 AND rt_time IS NOT NULL AND (strftime('%s', rt_date || ' ' || rt_time) - strftime('%s', date || ' ' || time)) / 60.0 >= 7.5 THEN journey_num END) AS delayed,
  AVG(CASE WHEN cancelled = 1 THEN 15 WHEN rt_time IS NOT NULL THEN MIN((strftime('%s', rt_date || ' ' || rt_time) - strftime('%s', date || ' ' || time)) / 60.0, 15) END) AS avg_delay,
  category,
  GROUP_CONCAT(DISTINCT operator) AS operators,
  GROUP_CONCAT(DISTINCT direction) AS destinations
FROM departures
WHERE operator IS NOT NULL
GROUP BY line, date, category;

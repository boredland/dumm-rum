ALTER TABLE `departures` ADD `ghost` integer DEFAULT 0 NOT NULL;
ALTER TABLE `station_daily_stats` ADD `ghost` integer DEFAULT 0 NOT NULL;
ALTER TABLE `operator_daily_stats` ADD `ghost` integer DEFAULT 0 NOT NULL;
ALTER TABLE `line_daily_stats` ADD `ghost` integer DEFAULT 0 NOT NULL;

DROP INDEX IF EXISTS `idx_departures_fetched`;--> statement-breakpoint
DROP INDEX IF EXISTS `idx_departures_operator_line`;--> statement-breakpoint
CREATE INDEX `idx_departures_station_fetched` ON `departures` (`station_id`,`fetched_at`);--> statement-breakpoint
CREATE INDEX `idx_departures_operator_date` ON `departures` (`operator`,`date`);--> statement-breakpoint
CREATE INDEX `idx_departures_date_notified` ON `departures` (`date`,`notified`);--> statement-breakpoint
CREATE INDEX `idx_operator_daily_stats_date` ON `operator_daily_stats` (`date`);--> statement-breakpoint
CREATE INDEX `idx_station_daily_stats_date` ON `station_daily_stats` (`date`);
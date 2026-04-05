CREATE TABLE `line_daily_stats` (
	`line` text NOT NULL,
	`date` text NOT NULL,
	`total` integer DEFAULT 0 NOT NULL,
	`cancelled` integer DEFAULT 0 NOT NULL,
	`delayed` integer DEFAULT 0 NOT NULL,
	`avg_delay` real,
	`category` text,
	`operators` text,
	`destinations` text,
	CONSTRAINT `line_daily_stats_pk` PRIMARY KEY(`line`, `date`)
);
--> statement-breakpoint
DROP INDEX IF EXISTS `idx_departures_next`;--> statement-breakpoint
CREATE INDEX `idx_line_daily_stats_date` ON `line_daily_stats` (`date`);--> statement-breakpoint
ALTER TABLE `departures` DROP COLUMN `journey_status`;--> statement-breakpoint
ALTER TABLE `departures` DROP COLUMN `reachable`;--> statement-breakpoint
ALTER TABLE `departures` DROP COLUMN `stop_ext_id`;
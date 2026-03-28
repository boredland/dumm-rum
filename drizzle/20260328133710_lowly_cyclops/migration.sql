CREATE TABLE IF NOT EXISTS `operator_daily_stats` (
	`operator` text NOT NULL,
	`date` text NOT NULL,
	`total` integer DEFAULT 0 NOT NULL,
	`cancelled` integer DEFAULT 0 NOT NULL,
	`avg_delay` real,
	CONSTRAINT `operator_daily_stats_pk` PRIMARY KEY(`operator`, `date`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `station_daily_stats` (
	`station_id` text NOT NULL,
	`date` text NOT NULL,
	`total` integer DEFAULT 0 NOT NULL,
	`cancelled` integer DEFAULT 0 NOT NULL,
	`avg_delay` real,
	`planned_freq` real,
	`actual_freq` real,
	CONSTRAINT `station_daily_stats_pk` PRIMARY KEY(`station_id`, `date`)
);

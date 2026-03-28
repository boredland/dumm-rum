CREATE TABLE IF NOT EXISTS `departures` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`station_id` text NOT NULL,
	`date` text NOT NULL,
	`time` text NOT NULL,
	`rt_date` text,
	`rt_time` text,
	`line` text NOT NULL,
	`direction` text NOT NULL,
	`journey_status` text DEFAULT 'P' NOT NULL,
	`cancelled` integer DEFAULT 0 NOT NULL,
	`operator` text,
	`category` text,
	`journey_num` text NOT NULL,
	`reachable` integer,
	`stop` text,
	`stop_ext_id` text,
	`fetched_at` text NOT NULL,
	CONSTRAINT `departures_station_id_date_time_line_direction_journey_num_unique` UNIQUE(`station_id`,`date`,`time`,`line`,`direction`,`journey_num`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `haikus` (
	`date` text NOT NULL,
	`station_id` text NOT NULL,
	`haiku` text NOT NULL,
	CONSTRAINT `haikus_pk` PRIMARY KEY(`date`, `station_id`)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_departures_station_date` ON `departures` (`station_id`,`date`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_departures_next` ON `departures` (`station_id`,`date`,`cancelled`,`time`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_departures_fetched` ON `departures` (`fetched_at`);

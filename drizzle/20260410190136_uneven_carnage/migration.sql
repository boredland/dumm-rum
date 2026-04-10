ALTER TABLE `departures` ADD `ghost` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `line_daily_stats` ADD `ghost` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `operator_daily_stats` ADD `ghost` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `station_daily_stats` ADD `ghost` integer DEFAULT 0 NOT NULL;
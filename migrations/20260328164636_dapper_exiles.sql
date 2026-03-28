ALTER TABLE `operator_daily_stats` ADD `delayed` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `station_daily_stats` ADD `delayed` integer DEFAULT 0 NOT NULL;
CREATE TABLE `telegram_subscriptions` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`chat_id` text NOT NULL,
	`line` text NOT NULL,
	`direction` text NOT NULL,
	`time_from` text,
	`time_to` text,
	`weekdays` text,
	`created_at` text NOT NULL,
	CONSTRAINT `telegram_subscriptions_chat_id_line_direction_unique` UNIQUE(`chat_id`,`line`,`direction`)
);
--> statement-breakpoint
CREATE INDEX `idx_telegram_line_dir` ON `telegram_subscriptions` (`line`,`direction`);
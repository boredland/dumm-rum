PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `__new_haikus` (
	`date` text PRIMARY KEY,
	`haiku` text NOT NULL
);
--> statement-breakpoint
INSERT OR IGNORE INTO `__new_haikus`(`date`, `haiku`) SELECT `date`, `haiku` FROM `haikus`;--> statement-breakpoint
DROP TABLE `haikus`;--> statement-breakpoint
ALTER TABLE `__new_haikus` RENAME TO `haikus`;--> statement-breakpoint
PRAGMA foreign_keys=ON;

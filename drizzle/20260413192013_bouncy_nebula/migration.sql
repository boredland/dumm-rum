CREATE TABLE `journey_runs` (
	`journey_ref` text NOT NULL,
	`day_of_operation` text NOT NULL,
	`line` text NOT NULL,
	`category` text,
	`operator` text,
	`line_id` text,
	`origin_stop_id` text NOT NULL,
	`origin_name` text NOT NULL,
	`origin_dep_time` text NOT NULL,
	`dest_stop_id` text NOT NULL,
	`dest_name` text NOT NULL,
	`dest_arr_time` text NOT NULL,
	`status` text NOT NULL,
	`cancelled` integer DEFAULT 0 NOT NULL,
	`part_cancelled` integer DEFAULT 0 NOT NULL,
	`cancelled_stop_count` integer DEFAULT 0 NOT NULL,
	`total_stop_count` integer NOT NULL,
	`was_tracked` integer DEFAULT 0 NOT NULL,
	`snapshot_at` text NOT NULL,
	CONSTRAINT `journey_runs_pk` PRIMARY KEY(`journey_ref`, `day_of_operation`)
);
--> statement-breakpoint
CREATE INDEX `idx_journey_runs_day` ON `journey_runs` (`day_of_operation`);--> statement-breakpoint
CREATE INDEX `idx_journey_runs_line_day` ON `journey_runs` (`line`,`day_of_operation`);--> statement-breakpoint
CREATE INDEX `idx_journey_runs_operator_day` ON `journey_runs` (`operator`,`day_of_operation`);
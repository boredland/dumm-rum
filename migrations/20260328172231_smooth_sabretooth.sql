CREATE INDEX `idx_departures_operator_line` ON `departures` (`operator`,`line`,`date`);--> statement-breakpoint
CREATE INDEX `idx_departures_date` ON `departures` (`date`);
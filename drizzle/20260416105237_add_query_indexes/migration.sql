CREATE INDEX "idx_journey_runs_line" ON "journey_runs" ("line","day_of_operation");--> statement-breakpoint
CREATE INDEX "idx_journey_runs_operator" ON "journey_runs" ("operator","day_of_operation");--> statement-breakpoint
CREATE INDEX "idx_journey_stops_stop_day" ON "journey_stops" ("stop_id","day_of_operation");
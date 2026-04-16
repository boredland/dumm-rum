DROP TABLE "journey_positions";--> statement-breakpoint
DROP TABLE "line_daily_stats";--> statement-breakpoint
DROP TABLE "operator_daily_stats";--> statement-breakpoint
ALTER TABLE "journey_runs" DROP COLUMN "part_cancelled";--> statement-breakpoint
ALTER TABLE "journey_runs" DROP COLUMN "cancelled_stop_count";--> statement-breakpoint
ALTER TABLE "journey_runs" DROP COLUMN "polyline";
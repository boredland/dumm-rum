ALTER TABLE "journey_runs" DROP COLUMN "status";--> statement-breakpoint
ALTER TABLE "journey_runs" DROP COLUMN "total_stop_count";--> statement-breakpoint
ALTER TABLE "journey_stops" DROP COLUMN "lat";--> statement-breakpoint
ALTER TABLE "journey_stops" DROP COLUMN "lon";--> statement-breakpoint
ALTER TABLE "known_stops" DROP COLUMN "updated_at";
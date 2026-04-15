CREATE TABLE "journey_positions" (
	"id" serial PRIMARY KEY,
	"journey_ref" text NOT NULL,
	"day_of_operation" text NOT NULL,
	"lat" real NOT NULL,
	"lon" real NOT NULL,
	"reported_at" text NOT NULL,
	"route_idx" integer,
	"rt_route_idx" integer,
	"captured_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "journey_runs" (
	"journey_ref" text,
	"day_of_operation" text,
	"line" text NOT NULL,
	"category" text,
	"operator" text,
	"origin_stop_id" text NOT NULL,
	"origin_name" text NOT NULL,
	"origin_dep_time" text NOT NULL,
	"dest_stop_id" text NOT NULL,
	"dest_name" text NOT NULL,
	"dest_arr_time" text NOT NULL,
	"status" text NOT NULL,
	"cancelled" boolean DEFAULT false NOT NULL,
	"part_cancelled" boolean DEFAULT false NOT NULL,
	"cancelled_stop_count" integer DEFAULT 0 NOT NULL,
	"total_stop_count" integer NOT NULL,
	"was_tracked" boolean DEFAULT false NOT NULL,
	"poll_state" text,
	"polyline" text,
	"snapshot_at" text NOT NULL,
	CONSTRAINT "journey_runs_pkey" PRIMARY KEY("journey_ref","day_of_operation")
);
--> statement-breakpoint
CREATE TABLE "journey_stops" (
	"journey_ref" text,
	"day_of_operation" text,
	"route_idx" integer,
	"stop_id" text NOT NULL,
	"stop_name" text NOT NULL,
	"dep_time" text,
	"arr_time" text,
	"rt_dep_time" text,
	"rt_arr_time" text,
	"cancelled" boolean DEFAULT false NOT NULL,
	"lat" real,
	"lon" real,
	CONSTRAINT "journey_stops_pkey" PRIMARY KEY("journey_ref","day_of_operation","route_idx")
);
--> statement-breakpoint
CREATE INDEX "idx_journey_pos_ref_day" ON "journey_positions" ("journey_ref","day_of_operation");--> statement-breakpoint
CREATE INDEX "idx_journey_pos_captured" ON "journey_positions" ("captured_at");--> statement-breakpoint
CREATE INDEX "idx_journey_runs_day" ON "journey_runs" ("day_of_operation");--> statement-breakpoint
CREATE INDEX "idx_journey_runs_poll_state" ON "journey_runs" ("poll_state","day_of_operation");--> statement-breakpoint
CREATE INDEX "idx_journey_stops_day" ON "journey_stops" ("day_of_operation");
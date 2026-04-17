CREATE TABLE "known_stops" (
	"stop_id" text PRIMARY KEY,
	"stop_name" text NOT NULL,
	"slug" text,
	"lines" text,
	"categories" text,
	"journey_count" integer DEFAULT 0 NOT NULL,
	"cancelled" integer DEFAULT 0 NOT NULL,
	"ghost" integer DEFAULT 0 NOT NULL,
	"delayed" integer DEFAULT 0 NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "line_daily_stats" (
	"line" text,
	"date" text,
	"total" integer DEFAULT 0 NOT NULL,
	"cancelled" integer DEFAULT 0 NOT NULL,
	"ghost" integer DEFAULT 0 NOT NULL,
	"delayed" integer DEFAULT 0 NOT NULL,
	"avg_delay" real,
	"category" text,
	"operators" text,
	"destinations" text,
	CONSTRAINT "line_daily_stats_pkey" PRIMARY KEY("line","date")
);
--> statement-breakpoint
CREATE TABLE "operator_daily_stats" (
	"operator" text,
	"date" text,
	"total" integer DEFAULT 0 NOT NULL,
	"cancelled" integer DEFAULT 0 NOT NULL,
	"ghost" integer DEFAULT 0 NOT NULL,
	"delayed" integer DEFAULT 0 NOT NULL,
	"avg_delay" real,
	CONSTRAINT "operator_daily_stats_pkey" PRIMARY KEY("operator","date")
);
--> statement-breakpoint
CREATE INDEX "idx_known_stops_slug" ON "known_stops" ("slug");--> statement-breakpoint
CREATE INDEX "idx_line_daily_stats_date" ON "line_daily_stats" ("date");--> statement-breakpoint
CREATE INDEX "idx_operator_daily_stats_date" ON "operator_daily_stats" ("date");
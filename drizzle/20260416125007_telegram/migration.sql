CREATE TABLE "telegram_subscriptions" (
	"id" serial PRIMARY KEY,
	"chat_id" text NOT NULL,
	"lang" text DEFAULT 'de' NOT NULL,
	"line" text NOT NULL,
	"direction" text NOT NULL,
	"stop_id" text DEFAULT '' NOT NULL,
	"time_ranges" text,
	"weekdays" text,
	"created_at" text NOT NULL,
	CONSTRAINT "telegram_subscriptions_chat_id_line_direction_stop_id_unique" UNIQUE("chat_id","line","direction","stop_id")
);
--> statement-breakpoint
CREATE INDEX "idx_telegram_line_dir" ON "telegram_subscriptions" ("line","direction");
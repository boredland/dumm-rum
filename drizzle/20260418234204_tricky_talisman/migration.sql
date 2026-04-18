-- UNLOGGED trades WAL durability (data is truncated on an unclean
-- shutdown) for a 5-10× write-throughput win. All values in this table
-- are recomputable on a cache miss, so the trade-off is correct here.
-- drizzle-kit doesn't emit UNLOGGED; this modifier is hand-applied.
CREATE UNLOGGED TABLE "unlogged_cache" (
	"key" text PRIMARY KEY,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_unlogged_cache_key" ON "unlogged_cache" USING hash ("key");
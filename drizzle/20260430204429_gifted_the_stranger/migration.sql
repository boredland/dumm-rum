-- Purge KVV journeys from the shared journey tables. The `kvv|` prefix
-- was the discriminator the deleted kvv-poll/kvv-map code keyed on; no
-- consumer in the app references these rows anymore.
DELETE FROM "journey_stops" WHERE "journey_ref" LIKE 'kvv|%';--> statement-breakpoint
DELETE FROM "journey_runs" WHERE "journey_ref" LIKE 'kvv|%';--> statement-breakpoint

-- Tear down the kvv pg-boss queues + cron so the scheduler doesn't try
-- to enqueue jobs against workers that no longer exist after restart.
-- Job rows would age out on their own retention window, but flushing
-- them now avoids a noisy log on the next worker boot.
--
-- Guarded on the schema existing: pg-boss creates it on its first
-- boss.start(), which on a brand-new database happens *after* migrate().
-- Unguarded, these three statements aborted the whole migration and the
-- process never came up at all. Existing databases already have the
-- schema and are unaffected either way.
DO $$
BEGIN
	IF EXISTS (SELECT 1 FROM information_schema.schemata WHERE schema_name = 'pgboss') THEN
		DELETE FROM "pgboss"."schedule" WHERE "name" IN ('kvv-discover', 'kvv-poll');
		DELETE FROM "pgboss"."job" WHERE "name" IN ('kvv-discover', 'kvv-poll');
		DELETE FROM "pgboss"."queue" WHERE "name" IN ('kvv-discover', 'kvv-poll');
	END IF;
END $$;--> statement-breakpoint

-- Coordinates were only populated by KVV's EFA (RMV's mgate doesn't
-- include them); without that ingest the columns are dead weight.
ALTER TABLE "journey_stops" DROP COLUMN "lat";--> statement-breakpoint
ALTER TABLE "journey_stops" DROP COLUMN "lon";

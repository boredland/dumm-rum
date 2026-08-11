-- Delete Mainz city bus traffic. Those buses reach the
-- Wiesbaden-Mainz-Kastel board across the Rhine, but Mainz is a different
-- network and outside what this site reports on. discover.ts and poll.ts
-- stop collecting it; this removes what was already stored.
--
-- Matched on the operator, not the line number: 54, 56 and 58 also run in
-- the Frankfurt area under DB Regio Bus Mitte and Transdev, and deleting by
-- number would take real data with it.
--
-- The station config carried `excludeCategories: ["Bus"]` for Mainz-Kastel,
-- which never matched: RMV reports the category as "Niederflurbus", so every
-- one of these runs was collected regardless. That config is now gone.
--
-- Record what the deletes below will make unfindable, before they run.
CREATE TEMP TABLE "mainz_scope" ON COMMIT DROP AS
SELECT DISTINCT jr."line", js."stop_id"
FROM "journey_runs" jr
LEFT JOIN "journey_stops" js
	ON js."journey_ref" = jr."journey_ref"
	AND js."day_of_operation" = jr."day_of_operation"
WHERE jr."operator" = 'Mainzer Mobilität';--> statement-breakpoint
-- Stop visits go first: journey_stops has no foreign key to journey_runs,
-- so deleting the runs first would orphan them with no way left to tell
-- which operator they belonged to.
DELETE FROM "journey_stops" js
WHERE EXISTS (
	SELECT 1 FROM "journey_runs" jr
	WHERE jr."journey_ref" = js."journey_ref"
		AND jr."day_of_operation" = js."day_of_operation"
		AND jr."operator" = 'Mainzer Mobilität'
);--> statement-breakpoint
DELETE FROM "journey_runs" WHERE "operator" = 'Mainzer Mobilität';--> statement-breakpoint
-- Subscriptions to a Mainz line can never fire again, because the runs no
-- longer exist. Only the composite slug shapes are safe to match: a bare
-- line name is matched on the number alone by notifySubscribers, so "58"
-- still serves the Frankfurt line 58 and must stay.
--
-- A line number alone is not enough either: 54, 56 and 58 also run in
-- Frankfurt, so a subscription to one of those is still valid. Only drop a
-- subscription whose line has no runs left at all.
--
-- `line` holds three shapes (see parseLineSlug in src/lib/utils.ts):
-- "source:category:line", the legacy "category:line", and a bare line name
-- typed into /subscribe. Read the line from the right position for each,
-- or a bare "28" — a Mainz-only line, now dead — would survive.
DELETE FROM "telegram_subscriptions" ts
WHERE (
	CASE length(ts."line") - length(replace(ts."line", ':', ''))
		WHEN 2 THEN split_part(ts."line", ':', 3)
		WHEN 1 THEN split_part(ts."line", ':', 2)
		ELSE ts."line"
	END
) IN (SELECT "line" FROM "mainz_scope")
	AND NOT EXISTS (
		SELECT 1 FROM "journey_runs" jr
		WHERE jr."line" = (
			CASE length(ts."line") - length(replace(ts."line", ':', ''))
				WHEN 2 THEN split_part(ts."line", ':', 3)
				WHEN 1 THEN split_part(ts."line", ':', 2)
				ELSE ts."line"
			END
		)
	);--> statement-breakpoint
-- Stops that only Mainz buses served now have no traffic left, so their
-- slug would resolve to a page with no departures. Scoped to those stops:
-- a stop can legitimately have no visits right now (a poll job still
-- queued), and it must keep its slug row or its page 404s.
DELETE FROM "known_stops" ks
WHERE ks."stop_id" IN (SELECT "stop_id" FROM "mainz_scope" WHERE "stop_id" IS NOT NULL)
AND NOT EXISTS (
	SELECT 1 FROM "journey_stops" js WHERE js."stop_id" = ks."stop_id"
)
-- A stop whose non-Mainz runs are still queued for their first poll has no
-- visits yet either. Keep those: the run exists, so the traffic is real.
AND NOT EXISTS (
	SELECT 1 FROM "journey_runs" jr
	WHERE jr."origin_stop_id" = ks."stop_id" OR jr."dest_stop_id" = ks."stop_id"
);

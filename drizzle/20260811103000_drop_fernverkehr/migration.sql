-- Delete long-distance traffic. The UI stopped displaying the Fernverkehr
-- bucket in cf2b18c, but the rows kept accruing; we now drop that traffic
-- for good, and discover.ts / poll.ts stop writing it.
--
-- Record which stops long-distance trains served, before the deletes below
-- remove the evidence. Used at the end to prune the known_stops rollup.
CREATE TEMP TABLE "fv_stop_ids" ON COMMIT DROP AS
SELECT DISTINCT js."stop_id"
FROM "journey_stops" js
JOIN "journey_runs" jr
	ON jr."journey_ref" = js."journey_ref"
	AND jr."day_of_operation" = js."day_of_operation"
WHERE normalize_category(jr."category") = 'Fernverkehr';--> statement-breakpoint
-- Stop visits go first: journey_stops has no foreign key to journey_runs,
-- so deleting the runs first would orphan them with no way left to tell
-- which bucket they belonged to.
DELETE FROM "journey_stops" js
WHERE EXISTS (
	SELECT 1 FROM "journey_runs" jr
	WHERE jr."journey_ref" = js."journey_ref"
		AND jr."day_of_operation" = js."day_of_operation"
		AND normalize_category(jr."category") = 'Fernverkehr'
);--> statement-breakpoint
DELETE FROM "journey_runs"
WHERE normalize_category("category") = 'Fernverkehr';--> statement-breakpoint
-- Subscriptions to a long-distance line can never fire again, because the
-- runs no longer exist. Remove them so no account keeps a silent
-- subscription.
--
-- `line` holds three shapes, matching parseLineSlug in src/lib/utils.ts:
-- "source:category:line", the legacy "category:line", and a bare line name
-- typed into /subscribe. Read the category from the right position for
-- each, and never from a bare name, where part 2 would be the line number.
--
-- A bare name is left alone on purpose: notifySubscribers matches those on
-- the line number only, so "74" still matches a surviving line 74 and
-- deleting it would drop a working subscription.
DELETE FROM "telegram_subscriptions"
WHERE normalize_category(
	CASE length("line") - length(replace("line", ':', ''))
		WHEN 2 THEN split_part("line", ':', 2)
		WHEN 1 THEN split_part("line", ':', 1)
	END
) = 'Fernverkehr';--> statement-breakpoint
-- Stops that only long-distance trains ever served now have no traffic
-- left, and their slug resolves to a page with no departures. Drop those
-- rollup rows.
--
-- Matched on "was served by a deleted long-distance run, and has nothing
-- left", not on the simpler "has no visits at all": a stop can legitimately
-- have zero visits right now (a poll job still queued, a station only just
-- configured), and that stop must keep its slug row or its page 404s.
DELETE FROM "known_stops" ks
WHERE ks."stop_id" IN (SELECT "stop_id" FROM "fv_stop_ids")
AND NOT EXISTS (
	SELECT 1 FROM "journey_stops" js WHERE js."stop_id" = ks."stop_id"
);

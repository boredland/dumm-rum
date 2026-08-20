#!/bin/bash
# Applies drizzle/20260820140000_delay_min_expression with ingest stopped.
#
# That migration rewrites journey_stops to put delay_min on delay_minutes().
# A rewrite takes ACCESS EXCLUSIVE for its whole duration, and a queued
# exclusive request parks every reader that arrives behind it — which is how
# the August outage happened. With the poller stopped nothing competes for the
# lock, so the window is just the rewrite itself.
#
# The site is DOWN for that window. journey_stops is unreadable while the lock
# is held, so /de and every stop page will fail. That is the trade being made
# deliberately; do not run this without having decided it is acceptable.
#
# Idempotent: if delay_min already uses delay_minutes() it exits without
# touching anything. Safe to re-run after an interruption — an interrupted
# rewrite rolls back whole, leaving the old column in place.
#
#   PGURL=... SERVICE=dummrum-ingest-xa4xiy ./scripts/rebuild-delay-min.sh
set -euo pipefail

PGURL="${PGURL:?PGURL is not set}"
SERVICE="${SERVICE:-dummrum-ingest-xa4xiy}"
MIGRATION="${MIGRATION:-/migration.sql}"

psql() { command psql "$PGURL" -v ON_ERROR_STOP=1 -qtA "$@"; }
log() { echo "[$(date -u +%FT%TZ)] $*"; }

# Test the VALUES, not the expression text. The column is deliberately spelled
# inline rather than as delay_minutes(...) — see the migration — so grepping the
# expression for the function name reports failure on a perfectly correct table,
# which is exactly what it did on the first successful run.
if [ "$(psql -c "
	SELECT count(*) FROM journey_stops
	WHERE delay_min IS DISTINCT FROM COALESCE(
		delay_minutes(dep_time, rt_dep_time),
		delay_minutes(arr_time, rt_arr_time))")" = "0" ]; then
	log "delay_min already agrees with delay_minutes() — nothing to do"
	exit 0
fi

before=$(psql -c "SELECT pg_size_pretty(pg_total_relation_size('journey_stops'))")
stale=$(psql -c "
	SELECT count(*) FROM journey_stops
	WHERE (rt_dep_time IS NOT NULL AND dep_time IS NOT NULL
			AND left(rt_dep_time,2)::int - left(dep_time,2)::int NOT BETWEEN -12 AND 12)
		OR (rt_arr_time IS NOT NULL AND arr_time IS NOT NULL
			AND left(rt_arr_time,2)::int - left(arr_time,2)::int NOT BETWEEN -12 AND 12)")
log "before: journey_stops $before, $stale stale row(s)"

# Scale to zero rather than pausing the queue: the poller holds short
# transactions on journey_stops around the clock, and the rewrite needs the
# lock granted immediately, not eventually.
log "stopping ingest ($SERVICE)"
docker service scale "$SERVICE=0" >/dev/null
until [ "$(docker service ps "$SERVICE" --filter desired-state=running -q | wc -l)" -eq 0 ]; do sleep 2; done

# Any connection still holding a lock keeps the rewrite queued behind it, and a
# queued exclusive request is what parks readers. Clear them before starting.
killed=$(psql -c "
	SELECT count(*) FROM (
		SELECT pg_terminate_backend(pid) FROM pg_stat_activity
		WHERE datname = current_database() AND pid <> pg_backend_pid()
			AND application_name NOT LIKE 'psql%'
	) t")
log "ingest stopped, cleared $killed connection(s)"

started=$SECONDS
set +e
command psql "$PGURL" -v ON_ERROR_STOP=1 -f "$MIGRATION"
rc=$?
set -e
elapsed=$((SECONDS - started))

log "restarting ingest ($SERVICE)"
docker service scale "$SERVICE=1" >/dev/null

if [ "$rc" -ne 0 ]; then
	log "FAILED after ${elapsed}s (rc=$rc) — the rewrite rolled back, schema unchanged"
	exit "$rc"
fi

log "rewrite completed in ${elapsed}s"

remaining=$(psql -c "
	SELECT count(*) FROM journey_stops
	WHERE delay_min IS DISTINCT FROM COALESCE(
		delay_minutes(dep_time, rt_dep_time), delay_minutes(arr_time, rt_arr_time))")
[ "$remaining" = "0" ] || { log "FAIL: $remaining row(s) still disagree with delay_minutes()"; exit 1; }

after=$(psql -c "SELECT pg_size_pretty(pg_total_relation_size('journey_stops'))")
log "verified: delay_min agrees with delay_minutes() on every row"
log "journey_stops $before -> $after"

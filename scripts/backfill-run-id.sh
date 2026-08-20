#!/bin/bash
# Server-side twin of scripts/backfill-run-id.ts, for running the backfill
# directly on the database host where the Bun toolchain is not installed.
#
# Same three phases, same guarantees: catalog-only ADD COLUMN, a transition
# trigger so the currently-deployed poller cannot create rows the backfill
# would miss, a batched backfill that commits per day, the targeted delay_min
# repair, then the replacement indexes built CONCURRENTLY.
#
# Run it DETACHED (docker run -d, nohup, systemd-run). A client timeout that
# kills this mid-backfill leaves the table half-converted — recoverable, since
# every step is idempotent and re-running resumes, but it wastes the pass.
#
#   psql must be on PATH and PGURL set to the database.
set -euo pipefail

PGURL="${PGURL:?PGURL is not set}"
BATCH="${BATCH:-20000}"
psql() { command psql "$PGURL" -v ON_ERROR_STOP=1 -qtA "$@"; }
log() { echo "[$(date -u +%FT%TZ)] $*"; }

log "phase 1: run_id column"
psql -c "ALTER TABLE journey_stops ADD COLUMN IF NOT EXISTS run_id integer" >/dev/null

log "phase 2: transition trigger"
psql >/dev/null <<'SQL'
CREATE OR REPLACE FUNCTION journey_stops_fill_run_id() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
	IF NEW.run_id IS NULL THEN
		SELECT r.run_id INTO NEW.run_id FROM journey_runs r
		WHERE r.journey_ref = NEW.journey_ref
			AND r.day_of_operation = NEW.day_of_operation;
	END IF;
	RETURN NEW;
END;
$fn$;
DROP TRIGGER IF EXISTS journey_stops_fill_run_id ON journey_stops;
CREATE TRIGGER journey_stops_fill_run_id
BEFORE INSERT OR UPDATE ON journey_stops
FOR EACH ROW EXECUTE FUNCTION journey_stops_fill_run_id();
SQL
log "trigger installed — new rows get run_id from journey_runs"

log "phase 3: backfill"
# Day at a time: only the current service day is written by the poller, so
# every earlier day converges in one pass and stays converged.
total=0
for day in $(psql -c "SELECT DISTINCT day_of_operation FROM journey_stops WHERE run_id IS NULL ORDER BY 1"); do
	dayrows=0
	while :; do
		n=$(psql -c "
			WITH batch AS (
				SELECT s.ctid AS cid, r.run_id AS rid
				FROM journey_stops s
				JOIN journey_runs r
					ON r.journey_ref = s.journey_ref
					AND r.day_of_operation = s.day_of_operation
				WHERE s.day_of_operation = '$day' AND s.run_id IS NULL
				LIMIT $BATCH
			)
			UPDATE journey_stops s SET run_id = batch.rid
			FROM batch WHERE s.ctid = batch.cid
			RETURNING 1" | wc -l)
		[ "$n" -eq 0 ] && break
		dayrows=$((dayrows + n))
		total=$((total + n))
	done
	log "backfill: $day +$dayrows (total $total)"
done

log "phase 4: orphans"
orphans=$(psql -c "DELETE FROM journey_stops WHERE run_id IS NULL RETURNING 1" | wc -l)
log "dropped $orphans orphan row(s)"

# Phase 5 (delay_min repair) intentionally removed. See the note above
# repairDelayMin in scripts/backfill-run-id.ts: on production the generated
# column carries the OLD INLINE expression in the catalog, not a call to
# delay_minutes(), so no UPDATE can ever recompute it correctly. Repairing it
# needs a column redefinition, which is a table rewrite and therefore a
# separate, scheduled piece of work.

log "phase 6: indexes (CONCURRENTLY, never blocks writes)"
build() {
	local name="$1" ddl="$2"
	# An interrupted CONCURRENTLY build leaves an INVALID index: never used,
	# still costs writes. Clear it before rebuilding.
	if [ "$(psql -c "SELECT count(*) FROM pg_class c JOIN pg_index i ON i.indexrelid=c.oid WHERE c.relname='$name' AND NOT i.indisvalid")" != "0" ]; then
		log "$name: dropping invalid leftover"
		psql -c "DROP INDEX CONCURRENTLY IF EXISTS $name" >/dev/null
	fi
	local t0=$SECONDS
	psql -c "$ddl" >/dev/null
	log "$name: built in $((SECONDS - t0))s"
}
build journey_stops_run_pkey \
	"CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS journey_stops_run_pkey ON journey_stops (run_id, route_idx)"
build idx_journey_stops_run_name \
	"CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_journey_stops_run_name ON journey_stops (run_id) INCLUDE (stop_name)"
build idx_journey_stops_origin_rt_run \
	"CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_journey_stops_origin_rt_run ON journey_stops (run_id) INCLUDE (rt_dep_time) WHERE route_idx = 0"
build idx_journey_stops_delay_min_run \
	"CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_journey_stops_delay_min_run ON journey_stops (run_id) WHERE delay_min >= 7.5"

log "phase 7: verify"
nulls=$(psql -c "SELECT count(*) FROM journey_stops WHERE run_id IS NULL")
[ "$nulls" = "0" ] || { log "FAIL: run_id NULL on $nulls row(s)"; exit 1; }
mismatch=$(psql -c "
	SELECT count(*) FROM journey_stops s
	JOIN journey_runs r ON r.journey_ref = s.journey_ref
		AND r.day_of_operation = s.day_of_operation
	WHERE s.run_id <> r.run_id")
[ "$mismatch" = "0" ] || { log "FAIL: run_id disagrees on $mismatch row(s)"; exit 1; }
log "verified: run_id complete and consistent with journey_runs"
log "done — safe to deploy 20260820120000_journey_stops_run_id"

# Journey-level tracking roadmap

Goal: move beyond per-stop-visit accounting in `departures` toward per-vehicle-run ("journey") data, so we can answer corridor-level questions ("how does S8 degrade between Wiesbaden and Frankfurt?"), build honest OTP metrics that don't double-count cross-station visits, reliably distinguish ghost departures from sensor dropouts, and eventually display live vehicle positions on a map.

## Status (as of 2026-04-14)

- **Phase 1: shipped** (`ed94bd3`, `56b7acc`). Captures `journey_ref` + `journey_status` on every departure row from the existing board response.
- **Phase 2a: shipped** (`97d1c1f`, `a26eeb6`). Nightly `journey_runs` snapshot: route topology from `/journeyDetail`, operational data derived from `departures`. Fires at 02:00 Berlin daily.
- **Phase 2b: skipped.** Inline ghost verification in the 5-min cron was a stepping stone — jumping straight to Phase 3 Queue-based polling instead (same infra, no throwaway work).
- **Phase 3: designed, not started.** Queue-based live journey polling + `journey_positions` time-series for live map.

## Empirical findings (constraints that shape the design)

From probing `/departureBoard` and `/journeyDetail` on RMV's HAFAS deployment:

1. **RMV strips ALL operational metadata from `/journeyDetail` overnight.** Cancellations, rt times, positions, AND per-stop `cancelled` flags are all gone by the next morning. A journey that showed `partCancelled: true` + all stops cancelled the same evening returns `cancelled: None, partCancelled: None, 0 cancelled stops` the next day. The `departures` table (which captured live flags via the board cron) is the only authoritative source for historical operational data.
2. **`journey_ref` is stable across stations on the same day.** Verified with 5 S1 journeys x 4 stations = 20 observations; all byte-identical. The `ZI#<N>` component identifies the journey-run; `TA#<N>` encodes the origin route index, not the reporting station.
3. **`(journey_ref, day_of_operation)` is a safe PK.** The ref token embeds `DA#YYMMDD`, but the explicit column protects against midnight-crossing edge cases.
4. **`JourneyStatus` is volatile.** RMV reports `R`/`A`/`S` while live and flips back to `P` after the journey completes. Phase 1's sticky-status rule preserves the most informative status ever seen.
5. **RMV never reports `JourneyStatus = 'R'` on `/departureBoard`.** Only `P` (planned) and `A` (additional) have been observed. The `R` status may only appear in `/journeyDetail` while live, or may be unused by RMV entirely.
6. **RMV only accepts `rtMode=OFF` or `rtMode=SERVER_DEFAULT`.** The OpenAPI spec lists `FULL`/`REALTIME`/`INFOS` but RMV rejects them with `API_PARAM`.
7. **`wasTracked` must use `rt_time IS NOT NULL` from departures, not `journey_status IN (R,A,S)`.** Since R is never reported on the board, the status check was always false. The rt_time check correctly identifies departures where the board had realtime data.

**Core constraint:** every "interesting" signal from `/journeyDetail` (positions, per-stop rt times, cancellation chains, vehicle progress) is only available **while the journey is live**. Anything not captured same-day is lost forever. This makes live polling the only way to get corridor-wide data.

### Cross-station redundancy

Measured 2026-04-13: 1,278 unique journeys produce 2,057 `departures` rows — ~60% row-count inflation from journeys that touch multiple tracked stations. Corridor-heavy stations carry most of the duplication (`3000933` at 81.7% shared, `3000129` at 78.9%, `3001507` at 77.1%, `3001217` at 73.8%).

Under Phase 3, `/journeyDetail.Stops[]` supplies per-stop rt data for every stop on a route — including stations we don't track — so per-station polling becomes redundant for *delay analytics*. What it can't be dropped for:
- Discovery of `A` (additional) / `S` (substitute) services added mid-day
- Per-station "next departures" UX if ever needed

Plausible Phase 3 cadence: hourly discovery poll per station (instead of every 3 min) + journey-primary polling via Queues.

## Phase 1 — Capture journey identity on each departure (done)

- Added `journey_ref TEXT` and `journey_status TEXT` to `departures`.
- `collect.ts` reads `dep.JourneyDetailRef.ref` and `dep.JourneyStatus` from the existing board response (zero new API calls).
- `journey_ref` uses `coalesce(excluded, existing)` on upsert (stable, first-non-null preserves).
- `journey_status` uses a CASE expression to preserve `R`/`A`/`S` once observed (sticky — prevents post-event `P` from downgrading).

## Phase 2a — Nightly `journey_runs` snapshot (done)

- `journey_runs` table keyed by `(journey_ref, day_of_operation)` with denormalized line/category/operator, origin/dest metadata, cancellation counts, `was_tracked` bit.
- `/journeyDetail` provides route topology (origin, dest, stop list, product info). Operational data (`cancelled`, `part_cancelled`, `was_tracked`) is derived from the `departures` table since RMV strips operational flags overnight.
- `wasTracked = 1` when any departure for this journey_ref has `rt_time IS NOT NULL`.
- Fires during the 02:00-02:03 Berlin window of the existing 3-min cron. Idempotent upserts on the PK.
- Module: `src/lib/journeyRuns.ts`, wired in `src/worker.ts`.

## Phase 3 — Live journey polling via Cloudflare Queues

### Goal

Poll `/journeyDetail` for journeys during their live window to capture data that RMV strips afterward: per-stop rt times, cancellation chains for the full corridor, vehicle positions (`lastPos`), and stop-progress (`lastPassRouteIdx`). This replaces the skipped Phase 2b and provides the foundation for a live vehicle map.

### Scope progression

**3a (scoped start):** Enqueue only "interesting" journeys — cancelled, ghost-suspect, or significantly delayed departures detected by the existing board cron. ~200 journeys/day, ~600 API calls.

**3b (full coverage):** Enqueue ALL journeys at discovery time. ~1,200 journeys/day, ~5,000 API calls. Enables corridor-wide OTP and live map for all services.

**3c (reduced board cadence):** Drop per-station board polling from every 3 min to every 30-60 min (discovery-only). Journey polling becomes the primary data source. Eliminates ~95% of current board API calls.

### Infrastructure: Cloudflare Queues

```toml
# wrangler.toml additions
[[queues.producers]]
binding = "JOURNEY_QUEUE"
queue = "journey-polls"

[[queues.consumers]]
queue = "journey-polls"
max_batch_size = 25
max_batch_timeout = 5
max_retries = 3
dead_letter_queue = "journey-polls-dlq"
```

`src/worker.ts` gets a `queue(batch, env, ctx)` handler alongside the existing `fetch` and `scheduled`.

### Adaptive polling strategy

For a journey with scheduled first departure at **T** and duration **D**:

```
Enqueue at: T - 5min

Poll 1 (T - 5m):
  Call /journeyDetail
  ├─ rt present (lastPos exists or any stop has rtDepTime)?
  │   → Record snapshot + position
  │   → Re-enqueue in 10min
  └─ No rt?
      → Re-enqueue at T + 5min

Poll 2 (T + 5m, only if no rt at poll 1):
  Call /journeyDetail
  ├─ rt present? → Record, continue adaptive polling every 10min
  └─ Still no rt? → Re-enqueue at T + 15min (last chance)

Poll 3 (T + 15m, only if still no rt):
  Call /journeyDetail
  ├─ rt present? → Late-tracked vehicle, record
  ├─ cancelled/partCancelled? → Confirmed cancellation, record, stop
  └─ Still nothing? → Ghost. Record verdict, stop polling.

Ongoing (for journeys WITH rt):
  Poll every ~10min
  Each poll captures progressive per-stop rtDepTime/rtArrTime + position
  Stop when: lastPassRouteIdx >= last stop index
             OR T + D + 15min reached (hard cap)
```

### Call budget

| Scenario | Calls/journey | Est. % of journeys |
|---|---|---|
| Rt appears immediately, short journey (<30 min) | 2-3 | ~40% |
| Rt appears, medium journey (30-60 min) | 4-6 | ~35% |
| No rt ever (ghost / untracked) | 3 then stop | ~15% |
| Rt appears late, medium journey | 5-7 | ~10% |

Full coverage (3b): ~1,200 journeys/day x ~4 avg = ~4,800 calls/day, ~3.3/min sustained.

### Ghost resolution from `/journeyDetail`

The consumer classifies each journey into one of three states:

| Signal | Verdict | Action |
|---|---|---|
| `lastPos` exists (vehicle GPS broadcasting) | Vehicle running, stop sensors silent | Clear ghost flag in `departures`, mark as sensor dropout |
| `cancelled`/`partCancelled` on journey or stops | Confirmed cancellation | Set `cancelled = 1` in `departures`, clear ghost |
| No `lastPos`, no cancellation, `JourneyStatus = P` at T+15m | Genuine ghost | Keep `ghost = 1` — scheduled service never dispatched |

### New table: `journey_positions`

Time-series of vehicle positions captured during live polling. One row per poll per journey (not one row per journey).

```ts
export const journeyPositions = sqliteTable(
  "journey_positions",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    journeyRef: text("journey_ref").notNull(),
    dayOfOperation: text("day_of_operation").notNull(),
    lat: real().notNull(),
    lon: real().notNull(),
    reportedAt: text("reported_at").notNull(),     // HAFAS lastPosReported timestamp
    routeIdx: integer("route_idx"),                // lastPassRouteIdx — last stop passed
    rtRouteIdx: integer("rt_route_idx"),            // rtLastPassRouteIdx
    capturedAt: text("captured_at").notNull(),     // when we polled
  },
  (t) => [
    index("idx_journey_pos_ref_day").on(t.journeyRef, t.dayOfOperation),
    index("idx_journey_pos_captured").on(t.capturedAt),
  ],
);
```

**Volume:** ~4,800 rows/day (full coverage), ~200 bytes/row = ~1 MB/day, ~30 MB/month. D1's 10 GB limit gives years of headroom.

**Pruning:** Optional cleanup job to drop positions older than N days if storage becomes a concern. Recommend keeping at least 90 days for replay/animation use.

#### Why D1, not Analytics Engine

Cloudflare Workers Analytics Engine was considered for position time-series but rejected:

- **Query ergonomics:** AE is queried via REST API with bearer auth, not the Worker D1 binding. Every SSR page showing position data would need an HTTP round-trip instead of a direct D1 query.
- **No JOINs:** A live map needs positions + journey metadata (line, category, origin). With D1, one JOIN query. With AE, two separate queries stitched in application code.
- **Blob-based schema:** AE uses `blob1..blob20` / `double1..double20` — no named columns, no Drizzle typing. Fragile at any team size.
- **3-month retention cap:** Fine for live display, but replay/animation beyond 3 months would lose data. D1 keeps it indefinitely.
- **Volume doesn't justify it:** AE shines at millions of events/day with aggregation. At ~5K positions/day, D1 handles it trivially.
- **Fire-and-forget writes** (AE's one advantage) can be approximated with `ctx.waitUntil()` for D1 batched INSERTs.

#### Live map query patterns

**Current positions (all active vehicles):**
```sql
SELECT jr.line, jr.category, jp.lat, jp.lon, jp.reported_at
FROM journey_positions jp
JOIN journey_runs jr ON jr.journey_ref = jp.journey_ref
  AND jr.day_of_operation = jp.day_of_operation
WHERE jp.captured_at > datetime('now', '-15 minutes')
ORDER BY jp.journey_ref, jp.captured_at DESC
-- Group by journey_ref, take first row each
```

**Replay (single journey trail):**
```sql
SELECT lat, lon, reported_at, route_idx
FROM journey_positions
WHERE journey_ref = ? AND day_of_operation = ?
ORDER BY captured_at
```

### Queue consumer flow (pseudocode)

```
queue(batch, env, ctx):
  client = createHafasClient(env.RMV_API_KEY)
  db = createDb(env.DB)

  for msg in batch.messages:
    { ref, dayOfOperation, pollCount } = msg.body

    detail = await client.GET("/journeyDetail", { id: ref })
    if error: msg.retry()

    // Record position if available
    if detail.lastPos:
      INSERT INTO journey_positions (ref, dayOp, lat, lon, reportedAt, routeIdx, ...)

    // Update journey_runs with live data (cancellations, stop rt times)
    UPSERT journey_runs with live cancellation chain from detail.Stops

    // Decide: re-enqueue or stop?
    if journey completed (lastPassRouteIdx >= last stop):
      msg.ack()
    else if no rt data and pollCount >= 3:
      msg.ack()  // ghost — stop polling
    else:
      msg.ack()
      queue.send({ ref, dayOfOperation, pollCount: pollCount + 1 },
                 { delaySeconds: detail.lastPos ? 600 : 300 })
```

### Known constraints

- **Queue per-message `delaySeconds` cap:** believed to be ~12h. For journeys scheduled >12h from enqueue, use tickler pattern (enqueue with 10h delay, consumer re-enqueues with remaining) or run discovery every 6-8h.
- **No cancel-scheduled-message:** If a journey is cancelled, its queued polls still fire — consumer must check-and-skip. Minor inefficiency (~200 wasted calls on disruption days).
- **Requires Workers Paid plan** (already in use).

## Open questions before Phase 3

- Verify current Cloudflare Queue per-message delay cap (believed ~12h).
- Confirm `lastPos` appears within a predictable window before scheduled departure (not only after vehicle starts moving).
- Test Queue consumer concurrency: can multiple consumers process the same queue simultaneously, or is it single-consumer?
- Measure `ctx.waitUntil()` reliability for D1 position INSERTs — if it's lossy under load, consider batching positions into a single INSERT per consumer batch invocation.
- Decide on Phase 3a scope: enqueue only ghost-suspects + cancelled (conservative), or all departures with `rt_time IS NULL` past cutoff (broader)?

## File and code references

- Schema: `src/db/schema.ts` (departures + journeyRuns; add journeyPositions for Phase 3)
- Journey snapshot: `src/lib/journeyRuns.ts` (nightly populator)
- Board collection: `src/lib/collect.ts` (cron-triggered, captures journey_ref/status)
- Worker dispatch: `src/worker.ts` (scheduled handler + future queue handler)
- HAFAS client: `src/lib/hafas.ts`
- HAFAS types: `src/lib/hafas-types.ts` (JourneyDetail at line 591, StopType at line 1401)
- Operational guide: `AGENTS.md` (D1 param limits, migration workflow, secrets)

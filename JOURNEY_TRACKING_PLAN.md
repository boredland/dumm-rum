# Journey-level tracking roadmap

Goal: move beyond per-stop-visit accounting in `departures` toward per-vehicle-run ("journey") data, so we can answer corridor-level questions ("how does S8 degrade between Wiesbaden and Frankfurt?"), build honest OTP metrics that don't double-count cross-station visits, and reliably distinguish ghost departures from sensor dropouts.

## Status (as of 2026-04-13)

- **Phase 1: shipped and deployed** (commits `ed94bd3`, `56b7acc` — `56b7acc` committed locally but **not yet pushed**).
- **Phase 2a: designed, not started.**
- **Phase 2b: outlined, not started.**
- **Phase 3: deferred — only pursue if product direction shifts toward vehicle tracking.**

## Empirical findings (useful constraints)

From probing `/departureBoard` and `/journeyDetail` on RMV's HAFAS deployment:

1. **`journey_ref` is stable across stations on the same day.** Verified with 5 S1 journeys × 4 stations = 20 observations; all byte-identical. The `ZI#<N>` component in the ref identifies the journey-run; `TA#<N>` encodes the origin route index, not the reporting station.
2. **`(journey_ref, day_of_operation)` is a safe PK.** The ref token embeds `DA#YYMMDD`, but the explicit column protects against midnight-crossing edge cases.
3. **RMV strips realtime data once a journey ages out.** Per-stop `rtDepTime`/`rtArrTime` and journey-level `lastPos`/`rtLastPassRouteIdx` are only present while the journey is live. Yesterday's `/journeyDetail` returns planned times only.
4. **Journey-level cancellation metadata IS preserved.** `partCancelled` and per-stop `cancelled` flags remain queryable after the fact, so after-hours snapshotting is viable for cancellation archival.
5. **`JourneyStatus` is volatile.** RMV reports `R`/`A`/`S` while live and flips back to `P` after the journey completes. Phase 1's sticky-status rule in `src/lib/collect.ts` preserves the most informative status ever seen.
6. **RMV only accepts `rtMode=OFF` or `rtMode=SERVER_DEFAULT`.** `FULL`/`REALTIME`/`INFOS` are rejected with `API_PARAM` despite the OpenAPI spec listing them.

These shape the plan below: the board cron is load-bearing (can't be replaced by journey polling because rt data only exists live), cancellations are archival-friendly (can be batched nightly), and ghost verification must be **same-day** (position data doesn't survive).

## Phase 1 — Capture journey identity on each departure ✅

**Goal.** Record `journey_ref` and `journey_status` on every `departures` row so downstream work can dedupe across stations and distinguish tracked/untracked/additional/substitute services.

**What was done.**
- Added `journey_ref TEXT` and `journey_status TEXT` columns to `departures` (`src/db/schema.ts`).
- Migration: `migrations/20260413173928_motionless_johnny_storm.sql`.
- `src/lib/collect.ts` reads `dep.JourneyDetailRef.ref` and `dep.JourneyStatus` — both already present in every `/departureBoard` response; zero new API calls.
- Upsert uses `coalesce(excluded, existing)` for `journey_ref` (stable, first-non-null preserves).
- Upsert uses `CASE` for `journey_status` to preserve `R`/`A`/`S` once observed (so post-event `P` re-fetches don't downgrade).

**Known gaps / follow-ups.**
- No index covers `journey_ref` yet. Add when the first query reads it.
- Ref stability across re-fetches of the same row has not been empirically verified (the `coalesce` upsert would mask any drift). Worth probing if Phase 2 surfaces weirdness.
- Old rows pre-deploy will have `journey_ref = NULL` forever — acceptable.

## Phase 2a — End-of-day `journey_runs` snapshot

**Goal.** Produce a canonical per-journey record of what actually ran yesterday, including full cancellation chain for all stops on the route (not just our tracked stations).

**Why it's cheap.** Cancellations are preserved in `/journeyDetail` after the fact (finding #4). No live-window scheduling needed — run once around 02:00 Berlin.

**New table: `journey_runs`**

```ts
export const journeyRuns = sqliteTable(
  "journey_runs",
  {
    journeyRef: text("journey_ref").notNull(),
    dayOfOperation: text("day_of_operation").notNull(),   // YYYY-MM-DD
    line: text().notNull(),
    category: text(),
    operator: text(),
    lineId: text("line_id"),                              // stable cross-day, e.g. "de:rmv:00000903:"
    originStopId: text("origin_stop_id").notNull(),
    originName: text("origin_name").notNull(),
    originDepTime: text("origin_dep_time").notNull(),
    destStopId: text("dest_stop_id").notNull(),
    destName: text("dest_name").notNull(),
    destArrTime: text("dest_arr_time").notNull(),
    status: text().notNull(),                             // last-known: P/R/A/S
    cancelled: integer().notNull().default(0),
    partCancelled: integer("part_cancelled").notNull().default(0),
    cancelledStopCount: integer("cancelled_stop_count").notNull().default(0),
    totalStopCount: integer("total_stop_count").notNull(),
    wasTracked: integer("was_tracked").notNull().default(0),  // true if any R/A/S seen in departures
    snapshotAt: text("snapshot_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.journeyRef, t.dayOfOperation] }),
    index("idx_journey_runs_day").on(t.dayOfOperation),
    index("idx_journey_runs_line_day").on(t.line, t.dayOfOperation),
    index("idx_journey_runs_operator_day").on(t.operator, t.dayOfOperation),
  ],
);
```

**Populator algorithm** (new function in `src/lib/collect.ts` or a sibling module):

```
1. Pull distinct journey_ref from departures WHERE date = yesterday AND journey_ref IS NOT NULL
2. Chunk into batches of ~10; Promise.all → GET /journeyDetail?id=<ref> per batch
3. For each response:
   - Extract origin/dest from Stops[0] / Stops[-1]
   - dayOfOperation from response.dayOfOperation
   - partCancelled from response.partCancelled
   - cancelledStopCount = count(Stops[*].cancelled = true)
   - totalStopCount = Stops.length
   - cancelled = (cancelledStopCount === totalStopCount)
4. wasTracked = EXISTS(SELECT 1 FROM departures WHERE journey_ref = :ref AND journey_status IN ('R','A','S'))
5. UPSERT into journey_runs with snapshot_at = now
```

**Scheduling.** Add a second cron trigger to `wrangler.toml` (e.g. `"30 0 * * *"` — 02:30 Berlin after DST), dispatch in `src/worker.ts`'s `scheduled` handler based on time-of-day.

**Expected volume.** ~500 distinct journeys/day × 1 call each = 500 `/journeyDetail` calls, spread over ~5 minutes. Well within RMV quota.

**Consumers (later work, not part of 2a).**
- Per-journey cancellation page ("S6 at 18:34 — cancelled between Langen and Frankfurt")
- Corrected per-line cancellation counts (one journey = one cancellation, not N stops)
- Substitute/additional service surfacing on operator pages

## Phase 2b — Live ghost verification

**Goal.** Replace the 15-min-cutoff heuristic with a definitive "did this vehicle run?" check, same-day only (position data decays overnight per finding #3).

**Trigger.** Inline in the existing 5-min cron (`src/lib/collect.ts:runCollection`), after the existing ghost-marking pass. For every row newly flagged `ghost = 1` this run (or candidate for flagging), call `/journeyDetail` for its `journey_ref`.

**Decision rule:**

| Signal from `/journeyDetail` | Verdict |
|---|---|
| `lastPassRouteIdx` ≥ index of this stop on the route | Vehicle passed — sensor dropout, not ghost. Clear ghost flag, record data-quality note. |
| `cancelled = true` or `partCancelled = true` with this stop in cancelled range | Real cancellation. Set `cancelled = 1`, clear ghost. |
| `JourneyStatus = R` but vehicle hasn't reached this stop yet | Wait — not a ghost yet. |
| No `lastPos`, status faded to `P` | Genuine ghost. Keep `ghost = 1`. |

**Volume.** ~5–20 ghost-candidates per cron tick × 288 ticks/day = ~2,000–5,000 `/journeyDetail` calls/day. Fine for RMV quota but worth monitoring.

**Risk.** Doubles the latency of the cron run (more HAFAS round-trips). Mitigate with `Promise.all` chunking.

## Phase 3 — Journey-primary architecture (deferred)

Only worth doing if the product shifts toward "follow this train" / live map features. The board cron becomes a discovery mechanism at reduced cadence (maybe hourly), and `/journeyDetail` polling becomes the primary data source with per-journey scheduled polls.

**Infrastructure: Cloudflare Queues.**

```toml
# wrangler.toml
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

**Pattern.**
1. Morning cron runs `/departureBoard` for discovery → enqueues one `{ type: "poll_journey", ref, dayOfOperation }` per distinct ref with `delaySeconds = scheduledDep - now - 5min`.
2. Consumer Worker receives batches of up to 25 due messages, calls `/journeyDetail` for each, upserts stop-level rt data.
3. If journey still live (`lastPos` advancing, not at final stop), consumer re-enqueues itself with `delaySeconds = 600`.
4. Otherwise drop.

**Known constraints.**
- Per-message `delaySeconds` is capped (≈12h at last check — **verify current value before committing**). For journeys scheduled >12h from enqueue, use the tickler pattern or run discovery every 6–8h.
- No cancel-scheduled-message operation. Consumer must check "is this journey still worth polling?" and no-op if not.
- Requires Workers Paid plan (already in use).

**Why not Durable Objects.** Queue's batching, retries, DLQ, and horizontal scaling beat DO alarm chaining for this shape of work. DO is the wrong primitive here.

**Why not now.** Phase 2 delivers most of the user-visible wins (corridor cancellation, honest OTP, ghost verification). Phase 3 is infrastructure-heavy and only unlocks features that aren't on the roadmap yet.

## Open questions to resolve before each phase

**Before 2a:**
- Does `/journeyDetail` return data for a ref that was valid yesterday but never ran (e.g. strike day)? Expected: yes, with `cancelled = true` across the stop chain. Worth one probe.
- Are there journey_refs that `/journeyDetail` 404s for (e.g. refs that expired)? Need retry/skip logic.

**Before 2b:**
- Confirm `lastPos` is populated within a predictable window before scheduled departure (not only while vehicle is actually moving).
- Test behavior for `partCancelled` journeys where this stop is in the non-cancelled section vs. cancelled section.

**Before 3:**
- Verify current Cloudflare Queue per-message delay cap.
- Measure Workers Paid plan quota headroom for sustained ~5k queue ops/day.

## File and code references

- Schema: `src/db/schema.ts` (add `journeyRuns` for Phase 2a)
- Collection: `src/lib/collect.ts` (Phase 2a populator, Phase 2b ghost verifier)
- Worker dispatch: `src/worker.ts` (branch on time-of-day in `scheduled` handler)
- HAFAS client: `src/lib/hafas.ts`
- HAFAS types: `src/lib/hafas-types.ts` (`JourneyDetail` at line 591, `Stop` fields, `JourneyStatus` enum `P|R|A|S`)
- Operational guide: `AGENTS.md` (D1 param limits, migration workflow, secrets)

## Unpushed work

- Commit `56b7acc` ("Keep journey_status sticky at R/A/S…") is local-only. Push before starting Phase 2a — or bundle it with the first Phase 2a commit.

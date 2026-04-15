# Next steps: Astro → ingest cutover

Living document. `next.dummrum.de` is the TanStack Start app in `ingest/`; `dummrum.de` is still the Astro + Cloudflare Worker. Goal is to bring `next.` to parity, swap DNS, decommission Cloudflare.

Ordered roughly by what unblocks what.

## 1. Stats materialization (worker) ← do first

The UI ports below all read from pre-aggregated tables that the current worker doesn't populate yet. Without this, every stats page does a full scan.

- Port `materializeOperatorStats`, `materializeLineStats`, `materializeKnownStops` from `root/src/lib/collect.ts` to the `ingest/` worker.
- SQLite → Postgres dialect: `strftime('%s', ...)` → `EXTRACT(EPOCH FROM ...)`; `GROUP_CONCAT` → `string_agg`; `date('now', '-7 days')` → `CURRENT_DATE - INTERVAL '7 days'`.
- Wire into the existing discover cron, or its own 30-min schedule.

## 2. Home page

Port `root/src/pages/[lang]/index.astro` → `ingest/src/routes/$lang/index.tsx`. Replaces the placeholder that's there now.

Needs: overall OTP, most-cancellations / most-ghosts / most-delays cards, station / operator / line summaries. All queries live in `root/src/lib/queries.ts` — port the ones used (`getOperatorSummaries`, `getLineSummaries`, `getStopSummaries`) into `ingest/src/lib/queries.ts`.

## 3. Station pages

- `/$lang/$station` — day stats + next departures.
- `/$lang/$station/day/$date` — per-day breakdown + all departures.

Uses `findStopBySlug`, `getStopStats`, `getStopDayDepartures`. Slug routing already solved in the Astro app — `STATIONS` list in `src/lib/stations.ts` is already ported.

## 4. Line pages

- `/$lang/line/$line`
- `/$lang/line/$line/day/$date`

`getLineStats`, `getLineDayJourneys`.

## 5. Operator pages

- `/$lang/operator/$operator`
- `/$lang/operator/$operator/day/$date`

`getOperatorStats`, `getOperatorDayJourneys`.

## 6. Search

Input wired to `search.placeholder` (already in i18n). Simple client-side fuzzy over the union of known lines / operators / stations via a new `search-index` server fn.

## 7. Yesterday snapshot

02:00 Berlin pg-boss schedule. Port `snapshotJourneys(yesterday)` from `root/src/lib/journeyRuns.ts` — re-fetches mgate JourneyDetails for every run discovered yesterday to fill in full topology (origin/dest stop id, polyline, total stop count). Runs discovered via StationBoard only have an origin-station slice.

## 8. Cutover operations

- **Postgres backups** — confirm Dokploy's scheduled-backup is enabled for `dummrum-postgres-x9lugc`; verify restore works.
- **Observability** — JSON structured logs (currently plain string). Either Axiom (we have the MCP) or whatever Dokploy ships.
- **DNS cutover plan** —
  1. Bring `next.` to parity with all routes above.
  2. (Optional) migrate historical D1 data → Postgres so stats don't start empty.
  3. Point `dummrum.de` at Dokploy, keep `next.` as a staging alias.
  4. Decommission Cloudflare Worker + D1 after a quiet week.

## 9. Haiku generation

Anthropic / OpenAI-compatible HTTP call per day, driven off worst-category-yesterday. Needs API key env var. Non-essential for cutover; purely decorative.

## 10. Position retention

`journey_positions` grows without bound. Either:

- 03:00 Berlin pg-boss job: `DELETE FROM journey_positions WHERE captured_at::timestamptz < now() - interval '24 hours'`.
- Or: convert to a TimescaleDB hypertable with a `drop_chunks` retention policy.

Vanilla delete is simpler; Timescale is cleaner if position volume grows.

## 11. Telegram bot

Port `handleTelegramWebhook` + `notifyJourneyIssues` (in `root/src/lib/telegram.ts`) behind an HTTP endpoint on `ingest`. Subscription table already in scope (needs schema addition). Low priority unless active subscribers need to be migrated.

## 12. Quality polish

- **404 component** — proper themed page for invalid `$lang`, missing stations, etc.
- **Accept-Language detection** in `/` — replace static `/de` redirect with a server fn reading request headers.
- **Share button** + Open Graph metadata per page.
- **Error boundaries** per route — server-fn failures currently surface TanStack's default error UI.
- **Daily-breakdown charts** — none in Astro; optional flourish.

---

## Not on this list (already done in `ingest/`)

- Bun + TanStack Start + Dockerfile-free railpack deploy
- Drizzle migrations (`bun run db:generate`)
- Postgres MCP (`.mcp.json.example`)
- Multilingual (`de`/`en` prefix routing)
- Map page: tiles, polling, markers, popups, motion (polyline snapping + observed-velocity extrapolation + eased easing), fullscreen, URL-hash state, refresh countdown
- Automatic dark/light mode (page chrome; map stays light)
- Tailwind v4

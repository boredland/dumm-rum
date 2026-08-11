# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```sh
# Dev (UI + workers in one process, hot-reload via Vite)
docker compose up -d          # postgres on :54321
DATABASE_URL="postgres://ingest:ingest@localhost:54321/ingest" bun run dev

# Worker-only (no UI, no vite build needed)
DATABASE_URL=... bun run worker
DATABASE_URL=... bun run worker:dev   # --watch

# Production
bun run build                 # vite build → dist/
DATABASE_URL=... bun run start  # bun serve.ts (static assets + SSR + workers)

# Check (typecheck + lint — runs in lefthook pre-commit)
bun run check                 # tsc --noEmit && biome check

# Format
bun run format                # biome check --write

# Schema changes
# 1. Edit src/db/schema.ts
# 2. bun run db:generate     # drizzle-kit generate
# 3. Commit the new drizzle/<ts>_name/ migration
# Migrations auto-apply at startup via migrate() in workers.ts
```

## Architecture

Single Bun process runs both the **TanStack Start SSR UI** and the **pg-boss ingestion workers**.

### Startup flow

`serve.ts` → imports `dist/server/server.js` (built by vite) → `src/server.ts` calls `startIngest()` at top level (migrations + pg-boss + workers) → then exports a fetch handler → `serve.ts` wraps it in `Bun.serve`, serving `dist/client/` for static assets and the fetch handler for everything else.

### Data flow

1. **Discovery** (pg-boss cron, default `*/5 * * * *`): `mgateStationBoardBatch` hits RMV's HAFAS mgate endpoint for all 13 configured stations in one POST → inserts skeleton `journey_runs` → enqueues poll jobs via `boss.insert()`.
2. **Polling** (pg-boss worker, batch=10): `mgateJourneyDetailsBatch` for 10 journey refs in one POST → upserts `journey_runs` (topology) + `journey_stops` (per-stop realtime) → re-enqueues at +60s until the journey terminates (passed last stop, hard time cap, 90 polls, or no RT data after 10 polls).
3. **UI**: TanStack Start routes call `createServerFn` handlers that query Postgres ad-hoc via drizzle. No materialized rollup tables — all aggregation is live GROUP BY on `journey_runs`/`journey_stops`.

### Key files

| File | Role |
|---|---|
| `src/lib/workers.ts` | `startIngest()` — migrations, pg-boss setup, cron + worker registration |
| `src/lib/discover.ts` | Station-board fan-out → journey_runs inserts → poll job enqueue |
| `src/lib/poll.ts` | Per-journey mgate polling → upsert runs/stops → re-enqueue or mark done |
| `src/lib/mgate.ts` | HAFAS mgate client (StationBoard + JourneyDetails batch) |
| `src/lib/queries.ts` | All read queries (summaries, stats, departures) consumed by UI routes |
| `src/lib/i18n.ts` | German/English translations, `t(lang, key, params?)` helper |
| `src/db/schema.ts` | Drizzle schema — `journey_runs`, `journey_stops`, `known_stops` |
| `src/server.ts` | TanStack Start server entry — starts workers + exports fetch handler |
| `serve.ts` | Bun.serve bootstrap — static file serving + SSR handler (outside src/) |

### Routing

Prefix-based i18n: `/$lang/...` where `$lang` is `de` or `en`. Root `/` redirects to `/de`. The `$lang` layout route validates the prefix and throws `notFound()` for invalid langs.

Entity detail pages follow: `/$lang/$station`, `/$lang/line/$line`, `/$lang/operator/$operator` — each with a `/day/$date` subroute for per-day departure lists.

### Server functions

All DB access goes through `createServerFn` from `@tanstack/react-start`. These run server-side only — drizzle/postgres imports don't leak to the client bundle. Route loaders call server fns; the client polls them for refreshes.

### Correlated subqueries in queries.ts

Drizzle's `${journeyRuns.journeyRef}` inside a `sql` template renders as an unqualified column name. In correlated subqueries this resolves to the inner table's column (self-reference). Always hardcode the table-qualified form: `"journey_runs"."journey_ref"`.

## RMV mgate protocol

POST to `https://www.rmv.de/auskunft/bin/jp/mgate.exe` with `{ svcReqL: [...], client, ver, lang, auth }`. Auth is a public AID, not a secret key.

- `StationBoard` — departure discovery. One request per station, batched in a single POST.
- `JourneyDetails` — per-journey enrichment. Up to 10 refs per POST with per-item error isolation.
- Error `LOCATION` = terminal (bad ref, mark done). `PARAMETER` = transient (can flip back to OK on the next call — retry up to 5 times).
- HAFAS service date is in the ref as `DA#DDMMYY` — prefer this over the response's `j.date` for overnight routes.

## Deployment

Railpack on Dokploy. `railpack.json` specifies `--ignore-scripts` on install (skips lefthook in the build container) and `bun serve.ts` as start command. `DATABASE_URL` env var required.

## Style conventions

- **Biome** with tabs, double quotes, recommended rules. `root: false` (inherits from parent repo's biome.json). `routeTree.gen.ts` is excluded.
- **Tailwind v4** via `@tailwindcss/vite`. Theme tokens in `src/styles.css` use `light-dark()` CSS function + `@theme inline` to expose them as tailwind colors.
- **dayjs** for all date arithmetic (not raw `Date` math). Helpers in `src/lib/utils.ts`.
- **No chunking** — Postgres handles large INSERT/SELECT fine. No stagger windows on job enqueuing.
- **Optimize for read performance**, not write reduction. No `setWhere` skip-if-unchanged guards.
- **Commit after every logical step**, not batched.

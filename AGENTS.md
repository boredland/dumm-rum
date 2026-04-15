# Agents

## Self-correction

When you discover that something works differently than you assumed (e.g. a Cloudflare or SQLite behavior, an Astro convention, a Drizzle ORM quirk, an RMV mgate response shape), update this file with the correct information so future sessions don't repeat the mistake. Examples below (D1's 100-param limit, `ALTER TABLE DROP COLUMN` rebuilding constraints, Workers not honoring `s-maxage` without the Cache API, mgate returning `crdEncYX` not raw `crd`, HAFAS service-day in the ref's `DA` field).

## Project overview

DummRum is a public transport cancellation and delay tracker for Frankfurt (Main) stations. A Cloudflare cron triggers departure-board discovery from RMV's `mgate.exe` endpoint every 30 minutes, feeds a per-journey poller via Cloudflare Queues that enriches each run with realtime/stop/position data, stores everything in a D1 database, materializes daily statistics, and serves an Astro SSR frontend with German/English i18n plus a live vehicle map.

Live at https://dummrum.de

## Tech stack

- **Astro 6** with `@astrojs/cloudflare` v13 adapter — SSR on Cloudflare Workers
- **Tailwind CSS v4** via `@tailwindcss/vite`
- **Cloudflare D1** for storage, **Cloudflare Queues** for per-journey polling fan-out, **Workers AI** for daily haiku generation
- **Drizzle ORM v1 beta** for typed queries and schema management
- **Biome** for linting/formatting, **Knip** for unused code detection, **tsgo** (`@typescript/native-preview`) for type checking
- **Lefthook** pre-commit hook runs all three checks
- **Playwright** (dev-only) for headless-browser empirical testing of the live map — see `scripts/watch-map.mjs`

## Concurrency

Use `better-all` (`import { all } from "better-all"`) instead of `Promise.all` for parallel async work in page frontmatter and other orchestration code. It takes an object of `() => Promise<T>` thunks and returns named results, which is clearer than positional destructuring.

## RMV API: mgate only

The project talks **exclusively** to RMV's `mgate.exe` JSON-RPC-style endpoint (`https://www.rmv.de/auskunft/bin/jp/mgate.exe`). The older REST `/hapi` API was removed in an earlier pass — do not reintroduce it. mgate is what the RMV web/app frontend uses, so availability tracks the user-facing site.

Protocol:

- POST with JSON body `{ svcReqL: [{meth, req}...], client, ver, lang, auth }`.
- Response `{ svcResL: [{meth, res, err}...] }` with per-request error isolation — one bad item in the batch doesn't fail the others. Take advantage of this: `mgateJourneyDetailsBatch` and `mgateStationBoardBatch` in `src/lib/mgate.ts` pack up to N requests per HTTP POST.
- The auth block is a hardcoded public `AID` (application identifier); no real API key. Multi-key `RMV_API_KEY` logic from the REST era is gone.

Methods used:

- `StationBoard` — departure-board discovery (replaces REST `/departureBoard`).
- `JourneyDetails` — per-journey enrichment (polyline + stops + realtime positions).

Error classification for `JourneyDetails`:

- `err: "OK"` → parsed response.
- `err: "LOCATION"` → permanently bad ref (classify as `terminal`; mark `pollState='done'`).
- `err: "PARAMETER"`, HTTP errors, parse failures, network errors → `transient`. **PARAMETER is sometimes transient** — the same ref that returned PARAMETER on one poll can return OK on the next. The poller re-enqueues with `mgateFailCount+1` and 60s delay, up to `MGATE_MAX_FAIL_COUNT=5` consecutive fails before giving up.
- Other codes observed: `API_QUOTA` (handled upstream in discovery REST, no longer a concern), `SVC_PARAM` (same class as PARAMETER).

Polyline format:

- Returned as a Google-algorithm **encoded string** in `crdEncYX` (not a raw `crd` number array in most client profiles — early assumption was wrong and produced null polylines for months). `mgate.ts`'s `decodePolyline` handles both the encoded and the raw/delta formats, always producing `[lat, lon]` degree pairs. Consumers just `JSON.stringify(points)`.

Service date:

- The HAFAS-canonical operating day for a journey is encoded in the ref as `DA#DDMMYY`. For overnight routes (trip after midnight), this is the *prior* calendar day — mgate's top-level `j.date` sometimes returns the calendar date instead. Always prefer `parseServiceDateFromRef(jid)` with `parseYyyymmdd(j.date)` as fallback.

## Key architecture decisions

- `vite` is pinned to `^7.3.1` via `overrides` in package.json to work around a version split bug between Astro's bundled vite and `@tailwindcss/vite` (withastro/astro#16029).
- `src/worker.ts` is a custom Cloudflare Worker entrypoint that delegates `fetch` to Astro's handler and adds a `scheduled` handler for cron-triggered data collection + a `queue` handler for the per-journey poller.
- `wrangler.toml` points `main` to `./src/worker.ts`; the adapter builds around this.
- All pages are server-rendered (`output: "server"`) since they query D1 on every request.
- Edge caching via Cloudflare Cache API in `src/worker.ts`. **Only sets a default `Cache-Control` when the response didn't already set one** — `/api/live-map` (30s) and past-date day pages (24h) rely on this; clobbering would break them.
- **Materialized daily stats**: `operator_daily_stats`, `line_daily_stats`, `known_stops` are populated by the cron after each collection run — page queries read pre-computed rows instead of aggregating raw journey data.
- Transport category icons (🚇🚋🚌) are derived from `journey_runs.category` / `journey_stops.category`, not hardcoded per station.
- Long-distance train categories (`ICE`, `EC`, `ECE`, `NJ`, `RJ`, `TGV`, `FLX`, etc.) are excluded both at discovery time (`EXCLUDE_CATEGORIES` in `collect.ts`) and in the `/api/live-map` query as defence in depth.

## Project structure

```
src/
├── worker.ts                     # Custom CF Worker entrypoint (fetch + scheduled + queue)
├── env.d.ts                      # Cloudflare.Env type augmentation
├── styles/app.css                # Tailwind entry with light-dark() theme tokens
├── layouts/Layout.astro          # Shared HTML shell (auto-refresh, share, nav)
├── db/
│   ├── schema.ts                 # Drizzle schema (journey_runs, journey_stops, journey_positions, daily stats)
│   ├── client.ts                 # createDb(d1) wrapper
│   └── helpers.ts                # d1BatchSize, excluded, coalesce, sqlIdList
├── components/
│   ├── HoursToggle.astro         # Days + category filter pills
│   ├── DepartureFilter.astro     # Client-side status/direction filter
│   └── StatusBadge.astro         # Departure status badge (cancelled/delayed/ghost/ok)
├── lib/
│   ├── mgate.ts                  # mgate client: JourneyDetails + StationBoard batch, polyline decode
│   ├── stations.ts               # Station config + slug helpers + SLUG_REDIRECTS
│   ├── queries.ts                # All DB read functions
│   ├── collect.ts                # Cron handler: discovery + materialization + haiku
│   ├── journeyRuns.ts            # Daily snapshot topology enrichment (02:00)
│   ├── journeyPoller.ts          # Queue consumer: per-journey mgate poll
│   ├── telegram.ts               # Telegram subscription + notifications
│   ├── i18n.ts                   # German/English translations
│   └── utils.ts                  # Date/time/format helpers
└── pages/
    ├── index.astro               # Accept-Language redirect to /de or /en
    ├── api/live-map.ts           # JSON endpoint feeding the live vehicle map
    └── [lang]/
        ├── index.astro           # Home: stops + lines + operators cards
        ├── map.astro             # Leaflet live-vehicle map
        ├── line/[line]/
        │   ├── index.astro       # Line overview
        │   └── day/[date].astro  # Line day detail
        ├── operator/[operator]/
        │   ├── index.astro       # Operator overview
        │   └── day/[date].astro  # Operator day detail
        └── [station]/
            ├── index.astro       # Station overview
            ├── day/[date].astro  # Station day detail
            └── api/stats.ts      # JSON stats endpoint
scripts/
└── watch-map.mjs                 # Headless-browser harness for empirical map A/B
```

## Data flow

1. Every 30 min, `scheduled` in `src/worker.ts` calls `runCollection()`.
2. `collect.ts` → `mgateStationBoardBatch` across all configured `STATIONS` in a single POST; filtered departures become skeleton `journey_runs` rows (no polyline/topology yet).
3. Skeleton rows get enqueued on `JOURNEY_QUEUE` for the per-journey poller.
4. Queue consumer (`journeyPoller.ts`) batches up to 10 refs per mgate POST, writes run/stop/position rows, re-enqueues polling up to 90 times per journey with 1-min delay until departure passes.
5. Day-rollover (02:00): `snapshotJourneys` re-polls yesterday's journeys to fill in topology that discovery missed.
6. Day-rollover (03:00): `journey_positions` older than 24h are pruned — the live-map only reads the newest fix per ref.
7. Page requests read materialized stats tables (fast) and raw queries for station/day detail pages.

### Write amplification knobs

Two `setWhere` predicates in `journeyPoller.ts` turn a "nothing changed" poll into a read-only no-op so we don't churn D1 rows. If you touch the stop/run upserts, keep them.

## Database schema

Managed by Drizzle ORM. Schema in `src/db/schema.ts`.

- **journey_runs** — one row per journey-ref + day-of-operation. Scheduled + meta (line, operator, category, origin/dest, times, polyline string, pollState).
- **journey_stops** — one row per (journey_ref, day, route_idx). Scheduled + realtime arr/dep times, stop lat/lon, cancelled flag.
- **journey_positions** — append-only GPS fixes. Pruned daily to 24h. `/api/live-map` reads the newest row per journey_ref.
- **haikus** — one AI-generated haiku per day (en + optional de).
- **operator_daily_stats** / **line_daily_stats** — materialized aggregates.
- **known_stops** — dereffed stop metadata used by home page and search.
- **telegram_subscriptions** — per-user line+direction subscriptions.

### Migrations

Drizzle generates migrations into `drizzle/` subdirectories. A `db:sync` script copies them to `migrations/` as flat SQL files for wrangler's D1 migration system.

```sh
npm run db:generate   # Generate migration + sync to migrations/
npm run db:migrate    # Apply to remote D1
```

**Important:** Always use `npm run db:generate` after changing `src/db/schema.ts` — never write migration SQL by hand. Drizzle Kit generates correct migrations that match the schema. Hand-written migrations risk schema/DB drift (e.g. `ALTER TABLE DROP COLUMN` silently rebuilding constraints incorrectly).

Migrations in `migrations/` are applied automatically on every deploy. To apply manually, use `npm run db:migrate` (not `wrangler d1 execute --file`), so the migration is recorded in the `d1_migrations` table and won't be re-run on deploy.

### Indexes

When adding, removing, or modifying queries in `src/lib/queries.ts` or `src/lib/collect.ts`, always check that the table indexes in `src/db/schema.ts` cover the new query's WHERE/GROUP BY/ORDER BY columns. Remove indexes that no longer match any query pattern to avoid write overhead. Unbounded DISTINCT or GROUP BY queries on large tables should be scoped to recent data (e.g. last 30 days) to avoid full table scans as data grows.

### D1's 100-parameter limit

D1 enforces a hard limit of **100 bound parameters per statement** (`D1_ERROR: too many SQL variables`). This bites hardest on multi-row inserts.

**Drizzle binds one parameter per non-autoincrement column on every row, including columns omitted from `.values()` that fall back to a schema default.** So `Object.keys(rowObject).length` undercounts the real param count whenever the schema has columns with defaults that you don't explicitly pass. A 7-row batch that "should" be 7×14=98 params can actually be 7×15=105 and silently fail every cron run — only the trailing partial batch (≤6 rows) gets through.

When batching inserts, derive the per-row param count from the schema, not from the values object. `src/db/helpers.ts` has `d1BatchSize(table)` that does this.

## Debugging the live map

The map is the most motion-sensitive part of the app — small changes to animation logic have non-obvious visual consequences. **Don't guess; measure.**

Fast iteration setup:

1. `npm run dev` — Astro dev server on `localhost:4321`. `astro.config.ts` has a dev-only Vite proxy that forwards `/api/live-map` to production so the browser sees real D1-backed data with no local DB copy.
2. Edit `src/pages/[lang]/map.astro`. Vite hot-reloads.
3. `npm run watch-map` — Playwright headless Chromium drives the page for 60s at 500ms samples, patches `L.map` to expose the Leaflet instance, records every marker's lat/lon per frame, and prints a distribution of per-frame jump distances.

Compare the "Per-500ms-frame shift distribution" table across runs to A/B animation changes. The `>1km` bucket is the "visible teleport" case; reducing it is usually what you want.

Env overrides: `MAP_URL=https://dummrum.de/en/map npm run watch-map` points the harness at production, `SAMPLE_COUNT=240 SAMPLE_MS=250 npm run watch-map` runs longer or finer-grained.

### Known traps

- **Per-journey GPS cadence is ~1 min**. That's the poller's per-journey poll interval; the client's 30s fetch mostly returns unchanged data. Any animation that forward-projects at schedule pace will drift kilometres if the vehicle runs late. Observed-velocity extrapolation (derive speed from two consecutive fixes) is what works.
- **Underground stretches (U-Bahn, S-Bahn tunnels) produce schedule-derived "fake" GPS**. Snap GPS to the nearest polyline point when a polyline is present so the marker stays on the rails.
- **Polylines arrive as Google-encoded `crdEncYX`**. The original parser only checked `crd` and produced null for months. See `src/lib/mgate.ts:decodePolyline`.
- **RMV often returns `arr == dep` at intermediate stops** for trams/S-Bahn/U-Bahn. Enforce a minimum 20s dwell at parse time so the marker visibly pauses at stations.

## Biome config notes

- `.astro` files have `noUnusedVariables` and `noUnusedImports` disabled (biome can't see template usage).
- `tailwindDirectives` CSS parser option is enabled for `@import "tailwindcss"`.
- The `noNonNullAssertion` warnings on Astro params (`Astro.params.station!`) are expected and intentional.
- Lefthook glob excludes `.json` files from biome (they're not in biome's includes list).

## Knip config notes

- `.astro` files are excluded from analysis (`ignore: ["src/**/*.astro"]`) since knip can't parse them.
- `tailwindcss` and `cloudflare` are in `ignoreDependencies` (virtual module imports).
- `ignoreExportsUsedInFile` is enabled because query interfaces are used via function return types.

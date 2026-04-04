# Agents

## Before starting work

Run `npm run generate:api` to update the HAFAS API types from the live OpenAPI spec.

## Project overview

DummRum is a public transport cancellation and delay tracker for Frankfurt (Main) stations. It collects departure data from the RMV HAFAS API every 5 minutes via a Cloudflare cron trigger, stores it in a D1 database, materializes daily statistics, and serves an Astro SSR frontend with German/English i18n showing per-station and per-operator statistics, charts, and per-day breakdowns.

Live at https://dummrum.de

## Tech stack

- **Astro 6** with `@astrojs/cloudflare` v13 adapter — SSR on Cloudflare Workers
- **Tailwind CSS v4** via `@tailwindcss/vite`
- **Cloudflare D1** for storage, **Workers AI** for daily haiku generation
- **Drizzle ORM v1 beta** for typed queries and schema management
- **openapi-typescript** + **openapi-fetch** for typed HAFAS API client
- **Biome** for linting/formatting, **Knip** for unused code detection, **tsgo** (`@typescript/native-preview`) for type checking
- **Lefthook** pre-commit hook runs all three checks

## Key architecture decisions

- `vite` is pinned to `^7.3.1` via `overrides` in package.json to work around a version split bug between Astro's bundled vite and `@tailwindcss/vite` (see withastro/astro#16029)
- `src/worker.ts` is a custom Cloudflare Worker entrypoint that delegates `fetch` to Astro's handler and adds a `scheduled` handler for cron-triggered data collection
- `wrangler.toml` points `main` to `./src/worker.ts` — the adapter builds around this
- All pages are server-rendered (`output: "server"`) since they query D1 on every request
- Edge caching via middleware (`s-maxage=300, stale-while-revalidate=60`) matches the 5-min cron interval
- **Materialized daily stats**: `station_daily_stats` and `operator_daily_stats` tables are populated by the cron after each collection run — page queries read pre-computed rows instead of aggregating raw departures
- Core hours mode (`?hours=core`) falls back to raw departures aggregation since it's not materialized
- `RMV_API_KEY` supports multiple comma-separated keys — each station picks a random key per cron run to distribute load
- Transport type icons (🚇🚋🚌) are derived from the `category` column in departure data, not hardcoded per station

## Project structure

```
src/
├── worker.ts                     # Custom CF Worker entrypoint (fetch + scheduled)
├── middleware.ts                  # Cache-Control headers for edge caching
├── env.d.ts                      # Cloudflare.Env type augmentation (DB, AI, RMV_API_KEY)
├── styles/app.css                # Tailwind entry with light-dark() theme tokens
├── layouts/Layout.astro          # Shared HTML shell (lang switcher, GitHub link)
├── db/
│   ├── schema.ts                 # Drizzle schema (departures, haikus, daily stats)
│   └── client.ts                 # createDb(d1) wrapper
├── components/
│   ├── HoursToggle.astro         # Hours / days / category filter toggles
│   ├── DepartureFilter.astro     # Client-side status filter for departure tables
│   └── StatusBadge.astro         # Departure status badge (cancelled/delayed/ok)
├── lib/
│   ├── stations.ts               # Station config array (STATIONS) and helpers
│   ├── queries.ts                # All DB query functions (reads materialized stats)
│   ├── collect.ts                # HAFAS API collection + materialization + haiku
│   ├── hafas.ts                  # Typed HAFAS API client (openapi-fetch)
│   ├── hafas-types.ts            # Auto-generated from OpenAPI spec (do not edit)
│   ├── i18n.ts                   # German/English translations
│   └── utils.ts                  # Date/time/formatting helpers
└── pages/
    ├── index.astro               # Accept-Language redirect to /de or /en
    └── [lang]/
        ├── index.astro           # Landing — station cards + operator accordion
        ├── operator/
        │   └── [operator].astro  # Operator detail — stats, chart, daily table
        └── [station]/
            ├── index.astro       # Station overview — stats, next deps, chart, table
            ├── day/[date].astro  # Day detail — all departures with delay/status
            └── api/stats.ts      # JSON API endpoint
```

## Data flow

1. Every 5 min, the `scheduled` handler in `src/worker.ts` calls `runCollection()`
2. For each station (in parallel): fetches departures from `rmv.de/hapi/departureBoard` and upserts into D1, generates a daily haiku via Workers AI (once per day)
3. After collection: materializes `station_daily_stats` and `operator_daily_stats` from raw departures for today
4. Page requests read from materialized stats tables (fast) — core hours mode falls back to raw aggregation

## Database schema

Managed by Drizzle ORM. Schema in `src/db/schema.ts`.

- **departures** — raw departure records (station_id, date, time, rt_time, line, direction, operator, category, cancelled, etc.)
- **haikus** — one AI-generated haiku per station per day
- **station_daily_stats** — materialized: total, cancelled, avg_delay, planned_freq, actual_freq per station per day
- **operator_daily_stats** — materialized: total, cancelled, avg_delay per operator per day

### Migrations

Drizzle generates migrations into `drizzle/` subdirectories. A `db:sync` script copies them to `migrations/` as flat SQL files for wrangler's D1 migration system.

```sh
npm run db:generate   # Generate migration + sync to migrations/
npm run db:migrate    # Apply to remote D1
```

**Important:** Migrations in `migrations/` are applied automatically on every deploy (via `npx wrangler d1 migrations apply` in the deploy command). Do NOT apply migrations manually with `wrangler d1 execute --file` — use `wrangler d1 migrations apply --remote` instead, so the migration is recorded in the `d1_migrations` table and won't be re-run on deploy.

### Indexes

When adding, removing, or modifying queries in `src/lib/queries.ts` or `src/lib/collect.ts`, always check that the `departures` table indexes in `src/db/schema.ts` cover the new query's WHERE/GROUP BY/ORDER BY columns. D1 has a 100-parameter limit per query — keep indexes lean. Remove indexes that no longer match any query pattern to avoid write overhead. Unbounded DISTINCT or GROUP BY queries on `departures` should be scoped to recent data (e.g. last 30 days) to avoid full table scans as data grows.

## RMV HAFAS API reference

Base URL: `https://www.rmv.de/hapi`

OpenAPI 3.0.1 spec: `https://www.rmv.de/hapi/api-doc`

Authentication: `accessId=<key>` query parameter or `Authorization: Bearer <key>` header.

### Endpoints used

#### `GET /departureBoard` — Departure Board (Section 2.25)

Returns departures from a station within a time window. Default duration is 60 minutes.

| Parameter | Required | Default | Description |
|-----------|----------|---------|-------------|
| `accessId` | M | — | API key |
| `id` | O | — | Station/stop ID (from `location.name`). Required if `extId` not set |
| `date` | O | today | Start date (`YYYY-MM-DD`) |
| `time` | O | now | Start time (`HH:mm`) |
| `duration` | O | 60 | Time window in minutes (0–1439) |
| `maxJourneys` | O | -1 | Max departures to return. `-1` = all within duration |
| `products` | O | all | Bitmask for transport types (bus=16, tram=4, U-Bahn=8) |
| `direction` | O | — | Filter by direction (station ID of last stop) |
| `lines` | O | — | Filter by line codes (comma-separated, `!` prefix to negate) |
| `operators` | O | — | Filter by operator codes (comma-separated) |
| `rtMode` | O | SERVER_DEFAULT | Realtime mode: `OFF`, `INFOS`, `FULL`, `REALTIME`, `SERVER_DEFAULT` |
| `format` | O | xml | Response format: `json` or `xml` |

Response root element: `DepartureBoard`. Contains a list of `Departure` objects with times, realtime data, tracks, journey references, and product info.

This project uses: `type=DEP`, `id`, `date`, `time`, `duration=120`, `maxJourneys=-1`, `format=json`.

#### `GET /location.name` — Location Search by Name (Section 2.3)

Pattern-matching search for stops, stations, addresses, and POIs.

| Parameter | Required | Default | Description |
|-----------|----------|---------|-------------|
| `accessId` | M | — | API key |
| `input` | M | — | Search string |
| `maxNo` | O | 10 | Max results (1–1000) |
| `type` | O | ALL | Filter: `S` (stops only), `A` (addresses), `P` (POIs), `ALL`, `SA`, `SP`, `AP` |
| `format` | O | xml | Response format |

Use `type=S` to search for station/stop IDs when adding new stations.

#### Finding station IDs without an API key

The RMV website exposes a public autocomplete endpoint that returns station IDs without authentication:

```
https://www.rmv.de/auskunft/bin/jp/ajax-getstop.exe/dn?REQ0JourneyStopsS0A=1&REQ0JourneyStopsS0G=<search-term>&js=true
```

The response contains `extId` fields with the station IDs (e.g., `003006903` → use `3006903` without leading zeros).

### API types

Types are auto-generated from the OpenAPI spec into `src/lib/hafas-types.ts`. The typed client is in `src/lib/hafas.ts`. Regenerate with `npm run generate:api`.

## Secrets (set via `wrangler secret put`)

- `RMV_API_KEY` — HAFAS API access key(s) for rmv.de. Supports multiple comma-separated keys for load distribution.

## Biome config notes

- `.astro` files have `noUnusedVariables` and `noUnusedImports` disabled (biome can't see template usage)
- `tailwindDirectives` CSS parser option is enabled for `@import "tailwindcss"`
- The `noNonNullAssertion` warnings on Astro params (`Astro.params.station!`) are expected and intentional
- Lefthook glob excludes `.json` files from biome (they're not in biome's includes list)

## Knip config notes

- `.astro` files are excluded from analysis (`ignore: ["src/**/*.astro"]`) since knip can't parse them
- `tailwindcss` and `cloudflare` are in `ignoreDependencies` (virtual module imports)
- `ignoreExportsUsedInFile` is enabled because query interfaces are used via function return types
- `src/lib/hafas-types.ts` is excluded (auto-generated)

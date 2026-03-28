# Agents

## Project overview

DummRum is a public transport cancellation and delay tracker for Frankfurt (Main) stations. It collects departure data from the RMV HAFAS API every 5 minutes via a Cloudflare cron trigger, stores it in a D1 database, and serves an Astro SSR frontend showing statistics, charts, and per-day breakdowns.

Live at https://dummrum.jonas-strassel.de

## Tech stack

- **Astro 6** with `@astrojs/cloudflare` v13 adapter — SSR on Cloudflare Workers
- **Tailwind CSS v4** via `@tailwindcss/vite`
- **Cloudflare D1** for storage, **Workers AI** for daily haiku generation
- **Biome** for linting/formatting, **Knip** for unused code detection, **tsgo** (`@typescript/native-preview`) for type checking
- **Lefthook** pre-commit hook runs all three checks

## Key architecture decisions

- `vite` is pinned to `^7.3.1` via `overrides` in package.json to work around a version split bug between Astro's bundled vite and `@tailwindcss/vite` (see withastro/astro#16029)
- `src/worker.ts` is a custom Cloudflare Worker entrypoint that delegates `fetch` to Astro's handler and adds a `scheduled` handler for cron-triggered data collection
- `wrangler.toml` points `main` to `./src/worker.ts` — the adapter builds around this
- All pages are server-rendered (`output: "server"`) since they query D1 on every request
- The `@ts-expect-error` on the tailwind vite plugin in `astro.config.ts` suppresses a known vite type mismatch — it works at runtime

## Project structure

```
src/
├── worker.ts                     # Custom CF Worker entrypoint (fetch + scheduled)
├── env.d.ts                      # Cloudflare.Env type augmentation (DB, AI, RMV_API_KEY)
├── styles/app.css                # Tailwind entry with custom theme tokens
├── layouts/Layout.astro          # Shared HTML shell
├── components/
│   ├── HoursToggle.astro         # All hours / core hours filter toggle
│   └── CancellationChart.astro   # SVG bar chart of daily cancellation rates
├── lib/
│   ├── stations.ts               # Station config array (STATIONS) and helpers
│   ├── queries.ts                # All D1 query functions (stats, departures, haiku, etc.)
│   ├── collect.ts                # HAFAS API collection + haiku generation (used by cron)
│   └── utils.ts                  # Date/time helpers (dayjs with Berlin timezone)
└── pages/
    ├── index.astro               # Landing page — station cards with cancellation rates
    └── [station]/
        ├── index.astro           # Station overview — stats, next departures, chart, table
        ├── day/[date].astro      # Day detail — all departures with delay/status
        └── api/stats.ts          # JSON API endpoint returning station stats
```

## Data flow

1. Every 5 min, the `scheduled` handler in `src/worker.ts` calls `runCollection()`
2. `runCollection()` fetches departures from `rmv.de/hapi/departureBoard` for each station and upserts into D1
3. It also generates a daily haiku per station using Workers AI (once per day)
4. Page requests query D1 directly via `import { env } from "cloudflare:workers"`

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

This project uses: `id`, `date`, `time`, `duration=120`, `maxJourneys=-1`, `format=json`.

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

### JSON response shape (departureBoard, `format=json`)

```ts
interface DepartureBoardResponse {
  Departure?: {
    date: string;          // "YYYY-MM-DD"
    time: string;          // "HH:mm:ss"
    rtDate?: string;       // realtime date
    rtTime?: string;       // realtime time
    direction: string;     // destination name
    JourneyStatus: string; // "P" = planned
    cancelled?: boolean;
    reachable?: boolean;
    stop?: string;
    stopExtId?: string;
    ProductAtStop: {
      line: string;        // e.g. "Bus 38"
      operator: string;
      catOut: string;      // category e.g. "Bus"
      num: string;         // journey number
    };
  }[];
}
```

## Secrets (set via `wrangler secret put`)

- `RMV_API_KEY` — HAFAS API access key for rmv.de

## Biome config notes

- `.astro` files have `noUnusedVariables` and `noUnusedImports` disabled (biome can't see template usage)
- `tailwindDirectives` CSS parser option is enabled for `@import "tailwindcss"`
- The `noNonNullAssertion` warnings on Astro params (`Astro.params.station!`) are expected and intentional

## Knip config notes

- `.astro` files are excluded from analysis (`ignore: ["src/**/*.astro"]`) since knip can't parse them
- `tailwindcss` and `cloudflare` are in `ignoreDependencies` (virtual module imports)
- `ignoreExportsUsedInFile` is enabled because query interfaces are used via function return types

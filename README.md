# DummRum

Wissen, ob man dumm rumsteht. Public transport cancellation and delay tracker for Frankfurt (Main).

**Live:** https://dummrum.jonas-strassel.de

## Setup

```sh
npm install
npm run dev
```

Secrets needed:

```sh
npx wrangler secret put RMV_API_KEY
```

The `RMV_API_KEY` supports multiple comma-separated keys for load distribution across the HAFAS API quota.

For local development, create a `.dev.vars` file:

```
RMV_API_KEY=your-key-here
```

Initialize the local D1 database:

```sh
npm run db:migrate:local
```

## Adding a station

All tracked stations are defined in `src/lib/stations.ts`. To add a new one:

1. **Find the station ID** on the [RMV departure board](https://www.rmv.de/). Search for your stop, open the departure board, and extract the `id` parameter from the URL (e.g. `3001586`).

2. **Add an entry** to the `STATIONS` array in `src/lib/stations.ts`:

   ```ts
   {
     id: "3001586",                              // RMV/HAFAS station ID
     name: "Frankfurt (Main) Draisbornstraße",   // Full display name
     slug: "draisbornstrasse",                   // URL slug (lowercase, no special chars)
   },
   ```

3. **Deploy.** The cron will start collecting data for the new station on the next run. Transport type icons are detected automatically from the data.

## Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Start dev server |
| `npm run build` | Build for production |
| `npm run check` | Type checking, linting, unused code detection |
| `npm run deploy` | Build, apply D1 migrations, deploy to Cloudflare |
| `npm run generate:api` | Regenerate HAFAS API types from OpenAPI spec |
| `npm run db:generate` | Generate Drizzle migration from schema changes |
| `npm run db:migrate` | Apply migrations to remote D1 |
| `npm run db:migrate:local` | Apply migrations to local D1 |

## Methodology

Every 5 minutes, the cron fetches the RMV HAFAS realtime feed for each tracked station and stores all departures. From this data:

- **Cancellation rate** = cancelled departures / total departures
- **Average delay** = mean of (actual departure time - scheduled time) across all departures with realtime data. For cancelled departures, the planned frequency is used as the assumed wait time. The delay calculation uses full datetime comparison to correctly handle cross-midnight departures.

## How it works

- A Cloudflare cron trigger (`*/5 * * * *`) calls the `scheduled` handler in `src/worker.ts`
- The handler fetches departures from the RMV HAFAS API for each station and upserts them into D1
- After collection, daily statistics are materialized into `station_daily_stats` and `operator_daily_stats` tables for fast page loads
- It also generates one haiku per station per day using Cloudflare Workers AI
- Astro SSR pages read from materialized stats tables
- The "next departures" section loads as a server island for instant page shells
- Edge caching (`s-maxage=300`) matches the cron interval
- Routes are prefixed with `/de/` or `/en/` — auto-detected from `Accept-Language`
- Light/dark theme follows system preference via CSS `light-dark()`
- Per-operator stats pages show cancellation rates and average delays
- A JSON API is available at `/{lang}/{station}/api/stats` for each station

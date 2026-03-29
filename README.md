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

1. **Find the station ID** — query the RMV HAFAS location search API or find it on the [RMV departure board](https://www.rmv.de/).

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

A cron trigger runs every minute and fetches the RMV HAFAS realtime feed for one station per invocation, rotating through all tracked stations. With 10 stations, each station is updated approximately every 10 minutes. ICE/IC/EC long-distance trains are excluded. From this data:

- **Cancellation rate** = cancelled departures / total departures
- **Delayed departures** = departures with delay ≥7.5 minutes (50% of assumed average 15-minute trip time within Frankfurt)
- **Average delay** = mean of (actual departure time - scheduled time) across all departures with realtime data. For cancelled departures, the planned frequency is used as the assumed wait time. Uses full datetime comparison to correctly handle cross-midnight departures.
- **On-time performance (OTP)** = % of departures neither cancelled nor delayed — [a standard metric in public transport](https://en.wikipedia.org/wiki/On-time_performance)
- **Trend arrows** compare this week's cancellation rate vs the previous week

## How it works

- A Cloudflare cron trigger (`* * * * *`) calls the `scheduled` handler in `src/worker.ts` every minute
- Each invocation processes one station, rotating via a KV-stored index — this keeps CPU usage within the Workers free plan limit (10ms per cron)
- After collection, daily statistics are materialized into `station_daily_stats` and `operator_daily_stats` tables for fast page loads
- It also generates one haiku per day using Cloudflare Workers AI
- Astro SSR pages read from materialized stats tables with edge caching (`s-maxage=300, stale-while-revalidate=300`)
- The "next departures" section loads as a server island for instant page shells
- Client-side navigation via Astro View Transitions for smooth page transitions
- Routes are prefixed with `/de/` or `/en/` — auto-detected from `Accept-Language`
- Light/dark theme follows system preference via CSS `light-dark()`
- Installable as a PWA via web app manifest
- Per-station, per-operator, and per-line detail pages with daily breakdowns, weekday patterns, and cancellation charts
- A JSON API is available at `/{lang}/{station}/api/stats` for each station

# DummRum

Public transport cancellation and delay tracker for Frankfurt (Main). Collects departure data from the RMV HAFAS API every 5 minutes, stores it in Cloudflare D1, and displays statistics per station.

**Live:** https://dummrum.jonas-strassel.de

## Setup

```sh
npm install
npm run dev
```

Requires a `wrangler.toml` with D1 and AI bindings (already configured), and the `RMV_API_KEY` secret:

```sh
npx wrangler secret put RMV_API_KEY
```

For local development, create a `.dev.vars` file:

```
RMV_API_KEY=your-key-here
```

Initialize the local D1 database:

```sh
npx wrangler d1 execute rmv-departures --local --file=./schema.sql
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
     type: "bus",                                // "bus" | "tram" | "underground"
     collectionStart: "2026-03-28",              // Date you start collecting (YYYY-MM-DD)
     collectionStartTime: "12:00:00",            // Time you start collecting (HH:MM:SS)
   },
   ```

3. **Deploy.** That's it — no database migration needed. The cron will start collecting data for the new station on the next run, and the pages will automatically pick it up.

The `collectionStart` and `collectionStartTime` fields filter out data before that point, so stats aren't skewed by a partial first day.

## Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Start dev server |
| `npm run build` | Build for production |
| `npm run check` | Run type checking, linting, and unused code detection |
| `npm run deploy` | Build and deploy to Cloudflare |

## How it works

- A Cloudflare cron trigger (`*/5 * * * *`) calls the `scheduled` handler in `src/worker.ts`
- The handler fetches departures from the RMV HAFAS API for each station and upserts them into D1
- It also generates one haiku per station per day using Cloudflare Workers AI
- Astro SSR pages query D1 directly and render stats, charts, and departure tables
- A JSON API is available at `/{station}/api/stats` for each station

# DummRum

Wissen, ob man dumm rumsteht. Public transport cancellation and delay tracker for Frankfurt (Main).

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
   },
   ```

3. **Deploy.** The cron will start collecting data for the new station on the next run, and the pages will automatically pick it up.

## Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Start dev server |
| `npm run build` | Build for production |
| `npm run check` | Run type checking, linting, and unused code detection |
| `npm run deploy` | Build and deploy to Cloudflare |
| `npm run generate:api` | Regenerate HAFAS API types from OpenAPI spec |

## How it works

- A Cloudflare cron trigger (`*/5 * * * *`) calls the `scheduled` handler in `src/worker.ts`
- The handler fetches departures from the RMV HAFAS API for each station and upserts them into D1
- It also generates one haiku per station per day using Cloudflare Workers AI
- Astro SSR pages query D1 directly and render stats, charts, and departure tables
- Routes are prefixed with `/de/` or `/en/` — auto-detected from `Accept-Language`
- Light/dark theme follows system preference via CSS `light-dark()`
- A JSON API is available at `/{lang}/{station}/api/stats` for each station

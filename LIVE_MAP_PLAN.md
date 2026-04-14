# Live Vehicle Map

A real-time map showing vehicle positions on a Leaflet/OpenStreetMap map, similar to [NEW ÖPNV Livekarte](https://livebus.new.de/maps/tlnp/place-marker).

## Data situation

**What we have today:**

| Table | Relevant fields | Notes |
|---|---|---|
| `journey_positions` | `journey_ref`, `day_of_operation`, `lat`, `lon`, `reported_at`, `route_idx`, `captured_at` | Time-series of GPS pings, one row per poll (~every 10 min while journey active) |
| `journey_runs` | `journey_ref`, `day_of_operation`, `line`, `category`, `operator`, `origin_name`, `dest_name`, `origin_dep_time`, `dest_arr_time`, `poll_state`, `cancelled` | Journey metadata for labeling markers |
| `journey_stops` | `journey_ref`, `day_of_operation`, `route_idx`, `stop_id`, `stop_name`, `dep_time`, `arr_time`, `rt_dep_time`, `rt_arr_time`, `cancelled` | Per-stop schedule, **no lat/lon stored** |
| `known_stops` | `stop_id`, `stop_name` | **No lat/lon stored** |

**What the HAFAS API provides but we don't store:**
- `StopType.lon`, `StopType.lat` — coordinates per stop in `/journeyDetail` responses
- `StopType.mainMastLon`, `StopType.mainMastLat` — platform-level coordinates

**Implication:** Vehicle dots are ready to go. Route polylines and stop markers would require either storing stop coordinates (schema change) or computing them client-side from known data. We defer route lines to a future iteration.

## Architecture

```
┌─────────────────────────────────────────────────────┐
│  Browser                                            │
│                                                     │
│  /de/map  or  /en/map                               │
│  ┌───────────────────────────────────────────────┐  │
│  │  Leaflet map (OSM tiles)                      │  │
│  │                                               │  │
│  │  ● S6 → Friedberg     ● U5 → Preungesheim    │  │
│  │       ● 12 → Fechenheim                       │  │
│  │                                               │  │
│  └───────────────────────────────────────────────┘  │
│  category filter pills: [U] [S] [Tram] [Bus] [RE]  │
│                                                     │
│  auto-refresh every 60s via fetch() to JSON API     │
└────────────────────┬────────────────────────────────┘
                     │  GET /api/live-map
                     ▼
┌─────────────────────────────────────────────────────┐
│  Cloudflare Worker  (SSR + API)                     │
│                                                     │
│  API: SELECT latest position per active journey     │
│  Page: Astro page that loads Leaflet from CDN       │
└─────────────────────────────────────────────────────┘
```

## Implementation steps

### 1. API endpoint: `/api/live-map.ts`

New file: `src/pages/api/live-map.ts`

**Query** (single SQL via Drizzle):
```sql
SELECT
  jr.journey_ref,
  jr.line,
  jr.category,
  jr.operator,
  jr.dest_name,
  jr.origin_name,
  jr.cancelled,
  jp.lat,
  jp.lon,
  jp.reported_at,
  jp.route_idx
FROM journey_runs jr
JOIN journey_positions jp
  ON jp.journey_ref = jr.journey_ref
 AND jp.day_of_operation = jr.day_of_operation
WHERE jr.day_of_operation = :today
  AND jr.poll_state = 'polling'
  AND jr.cancelled = 0
  AND jp.id = (
    SELECT id FROM journey_positions jp2
    WHERE jp2.journey_ref = jr.journey_ref
      AND jp2.day_of_operation = jr.day_of_operation
    ORDER BY jp2.captured_at DESC
    LIMIT 1
  )
```

**Response shape:**
```json
{
  "vehicles": [
    {
      "id": "...",
      "line": "S6",
      "category": "S",
      "operator": "DB Regio AG S-Bahn Rhein-Main",
      "origin": "Frankfurt (Main) Südbahnhof",
      "destination": "Friedberg(Hess)",
      "lat": 50.1234,
      "lon": 8.6789,
      "reportedAt": "2026-04-14T14:32:00+02:00",
      "routeIdx": 5
    }
  ],
  "updatedAt": "2026-04-14T14:35:00Z"
}
```

**Caching:** Set `Cache-Control: s-maxage=30, stale-while-revalidate=30` — positions update every ~10 min so 30s cache is fine. The existing worker fetch handler already caches JSON responses with the response's cache headers.

### 2. Map page: `/[lang]/map.astro`

New file: `src/pages/[lang]/map.astro`

**Approach:** A full-bleed Astro page that:
- Uses the existing `Layout.astro` but with the map filling the content area
- Loads Leaflet CSS + JS from CDN (`unpkg.com/leaflet@1.9`)
- No npm dependency needed — Leaflet from CDN keeps the bundle unchanged

**Page structure:**
```
<Layout>
  <div id="map" style="height: calc(100dvh - 120px)">
  <div> category filter pills (client-side filtering)
</Layout>
<script>
  // init map, fetch /api/live-map, place markers, auto-refresh
</script>
```

**Map defaults:**
- Center: Frankfurt (50.11, 8.68)
- Zoom: 12
- Tiles: `https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png`

### 3. Marker rendering

Each vehicle gets a `L.circleMarker` (not icon-based — simpler, faster, scales well):

| Category | Color | Radius |
|---|---|---|
| U-Bahn | `#0065ae` (Frankfurt U-Bahn blue) | 7 |
| S | `#00843d` (S-Bahn green) | 7 |
| Tram | `#c4122e` (red) | 6 |
| Bus | `#93559a` (purple) | 5 |
| RE, RB | `#ec6608` (orange) | 7 |

**Popup on click:**
```
S6 → Friedberg(Hess)
DB Regio AG
Position: 14:32
```

**Tooltip on hover:** `S6 → Friedberg`

### 4. Client-side behavior

```
on page load:
  1. init Leaflet map
  2. fetch /api/live-map
  3. render markers into a LayerGroup
  4. start 60s refresh interval

on refresh tick:
  1. fetch /api/live-map
  2. diff against existing markers (keyed by journey_ref)
     - new journeys: add marker
     - moved journeys: setLatLng() (smooth update)
     - gone journeys: remove marker
  3. update "last updated" timestamp display

on category pill click:
  filter markers client-side (show/hide by category)
```

### 5. Navigation link

Add a map link to the landing page header and/or the global nav area. A small map icon (SVG) linking to `/{lang}/map`.

### 6. i18n

Add keys to `src/lib/i18n.ts`:

| Key | DE | EN |
|---|---|---|
| `map.title` | `Livekarte` | `Live Map` |
| `map.vehicles` | `Fahrzeuge` | `Vehicles` |
| `map.last_update` | `Letztes Update` | `Last update` |
| `map.no_vehicles` | `Keine aktiven Fahrzeuge` | `No active vehicles` |

## File changes summary

| File | Action | Description |
|---|---|---|
| `src/pages/api/live-map.ts` | **new** | JSON API endpoint returning active vehicle positions |
| `src/pages/[lang]/map.astro` | **new** | Map page with Leaflet |
| `src/lib/i18n.ts` | edit | Add map-related translation keys |
| `src/layouts/Layout.astro` | edit | Add nav link to map page |

## Constraints and limitations

- **Position staleness:** Positions update every ~10 min per journey (queue consumer poll interval). The map will show the last known position, not real-time GPS. The `reportedAt` timestamp lets users see how fresh each position is.
- **Coverage:** The 13 monitored stations cover effectively all journeys in Frankfurt, so the map shows city-wide coverage.
- **No route lines (v1):** Stop coordinates aren't stored. We'd need a migration adding `lat`/`lon` to `journey_stops` to draw polylines. Deferred.
- **D1 query cost:** The correlated subquery for "latest position per journey" is fine for the expected ~50-200 active journeys at any time.
- **Leaflet from CDN:** Avoids bloating the Vite bundle. Leaflet is ~40 KB gzipped. If offline support or tighter integration is needed later, it can be moved to an npm dep.

## Backfill stop coordinates

Stop coordinates (`lat`/`lon`) were added to `journey_stops` on 2026-04-15. New polls fill them automatically. To propagate coords to historical rows, wait for 2-3 poll cycles (~4-6 hours) then run:

```sh
# Check how many rows already have coordinates
npx wrangler d1 execute rmv-departures --remote --command \
  "SELECT COUNT(*) as total, SUM(CASE WHEN lat IS NOT NULL THEN 1 ELSE 0 END) as with_coords FROM journey_stops;"

# Backfill: copy coords from any row that has them to all rows sharing the same stop_id
npx wrangler d1 execute rmv-departures --remote --command \
  "UPDATE journey_stops SET lat = (SELECT js2.lat FROM journey_stops js2 WHERE js2.stop_id = journey_stops.stop_id AND js2.lat IS NOT NULL LIMIT 1), lon = (SELECT js2.lon FROM journey_stops js2 WHERE js2.stop_id = journey_stops.stop_id AND js2.lon IS NOT NULL LIMIT 1) WHERE lat IS NULL;"
```

Safe to run multiple times — only touches rows where `lat IS NULL`.

## Future enhancements (not in scope)

- **Route polylines:** Store stop lat/lon in `journey_stops`, draw the route line per vehicle
- **Historical replay:** Slider to replay a day's positions (data already in `journey_positions`)
- **Delay heatmap:** Color-code map regions by average delay
- **Stop markers:** Show monitored stops on the map with live departure info on click
- **Clustering:** If vehicle count grows, use `Leaflet.markercluster`

import { createFileRoute } from "@tanstack/react-router";
import { getActiveKvvVehicles } from "../../../lib/kvv-map.ts";

/** Per-run positions are recomputed against `journey_stops` on every
 * request — cheap (tens of rows in the active window) but not free,
 * so a short edge cache pairs with the 15 s livemap poll. SWR bridges
 * restarts without stalling the client. */
const CACHE_CONTROL =
	"public, max-age=5, s-maxage=10, stale-while-revalidate=30";

const DEFAULT_BBOX = {
	// Greater Karlsruhe + Durlach corridor — a conservative fallback when
	// the client forgets to pass bounds. Barely matters in practice; the
	// client always sends the Leaflet bbox.
	swLat: 48.95,
	swLon: 8.25,
	neLat: 49.1,
	neLon: 8.55,
};

function parseBbox(url: URL): {
	swLat: number;
	swLon: number;
	neLat: number;
	neLon: number;
} {
	const n = (s: string | null, d: number) => {
		const v = Number(s);
		return Number.isFinite(v) ? v : d;
	};
	return {
		swLat: n(url.searchParams.get("swLat"), DEFAULT_BBOX.swLat),
		swLon: n(url.searchParams.get("swLon"), DEFAULT_BBOX.swLon),
		neLat: n(url.searchParams.get("neLat"), DEFAULT_BBOX.neLat),
		neLon: n(url.searchParams.get("neLon"), DEFAULT_BBOX.neLon),
	};
}

export const Route = createFileRoute("/api/kvv/vehicles")({
	server: {
		handlers: {
			GET: async ({ request }) => {
				const url = new URL(request.url);
				const bbox = parseBbox(url);
				const now = new Date();
				const vehicles = await getActiveKvvVehicles(bbox, now);
				const body = JSON.stringify({
					vehicles,
					serverTime: now.getTime(),
				});
				return new Response(body, {
					headers: {
						"Content-Type": "application/json",
						"Cache-Control": CACHE_CONTROL,
					},
				});
			},
		},
	},
});

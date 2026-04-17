import { createFileRoute } from "@tanstack/react-router";
import { getActiveFerryVehicles } from "../../../lib/ferry.ts";

/** Ferry waypoints are deterministic for the whole service day — their
 * timestamps are anchored to the published timetable and the client
 * interpolates positions locally from the returned polyline + times. That
 * means every poll within the same minute returns an identical payload,
 * so we can cache aggressively at the edge and still have accurate
 * markers. 60 s gives Cloudflare a wide window to coalesce requests
 * without losing accuracy; SWR bridges restarts. */
const CACHE_CONTROL =
	"public, max-age=30, s-maxage=60, stale-while-revalidate=300";

export const Route = createFileRoute("/api/ferry/vehicles")({
	server: {
		handlers: {
			GET: async () => {
				const now = new Date();
				const vehicles = getActiveFerryVehicles(now);
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

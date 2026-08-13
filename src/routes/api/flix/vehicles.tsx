import { createFileRoute } from "@tanstack/react-router";
import { getAggregatedVehicles } from "../../../lib/flix-proxy.ts";
import { memoGet } from "../../../lib/memo.ts";

/** Flix vehicles are viewport-independent (one global payload for every
 * client) and already memoized at the origin for 25 s, so letting
 * Cloudflare serve the response for a handful of seconds gives a near-1:1
 * reduction in origin fetches during traffic spikes. Clients poll every
 * 15 s; a 10 s edge TTL means most simultaneous polls from different
 * users hit the edge instead of origin. SWR extends that window during
 * briefly-failing origin. */
const CACHE_CONTROL =
	"public, max-age=5, s-maxage=10, stale-while-revalidate=30";

export const Route = createFileRoute("/api/flix/vehicles")({
	server: {
		handlers: {
			GET: async () => {
				try {
					const body = await memoGet("vehicles", 25, getAggregatedVehicles);
					return new Response(body, {
						headers: {
							"Content-Type": "application/json",
							"Cache-Control": CACHE_CONTROL,
						},
					});
				} catch (e) {
					console.error("flix vehicles error:", e);
					return new Response(null, {
						status: 502,
						headers: { "Cache-Control": "no-store" },
					});
				}
			},
		},
	},
});

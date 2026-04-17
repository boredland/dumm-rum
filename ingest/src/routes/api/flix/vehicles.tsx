import { createFileRoute } from "@tanstack/react-router";
import { getAggregatedVehicles, memoGet } from "../../../lib/flix-proxy.ts";

export const Route = createFileRoute("/api/flix/vehicles")({
	server: {
		handlers: {
			GET: async () => {
				try {
					const body = await memoGet("vehicles", 25, getAggregatedVehicles);
					return new Response(body, {
						headers: {
							"Content-Type": "application/json",
							"Cache-Control": "public, max-age=25, stale-while-revalidate=30",
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

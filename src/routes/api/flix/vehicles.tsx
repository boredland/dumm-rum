import { createFileRoute } from "@tanstack/react-router";
import { getAggregatedVehicles, memoGet } from "../../../lib/flix-proxy.ts";

export const Route = createFileRoute("/api/flix/vehicles")({
	server: {
		handlers: {
			GET: async () => {
				try {
					const body = await memoGet("vehicles", 25, getAggregatedVehicles);
					// No Cache-Control: clients request fresh every poll.
					// Server-side memo still coalesces concurrent fan-outs
					// so Flix's upstream is protected.
					return new Response(body, {
						headers: {
							"Content-Type": "application/json",
							"Cache-Control": "no-store",
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

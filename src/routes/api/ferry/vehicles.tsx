import { createFileRoute } from "@tanstack/react-router";
import { getActiveFerryVehicles } from "../../../lib/ferry.ts";

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
						"Cache-Control": "no-store",
					},
				});
			},
		},
	},
});

import { createFileRoute } from "@tanstack/react-router";
import { getRoutePolyline } from "../../../../lib/flix-proxy.ts";
import { memoGet } from "../../../../lib/memo.ts";

export const Route = createFileRoute("/api/flix/route/$uuid")({
	server: {
		handlers: {
			GET: async ({ params }) => {
				try {
					const body = await memoGet(`route:${params.uuid}`, 3600, () =>
						getRoutePolyline(params.uuid),
					);
					return new Response(body, {
						headers: {
							"Content-Type": "application/json",
							"Cache-Control": "public, max-age=3600, immutable",
						},
					});
				} catch (e) {
					console.error("flix route error:", e);
					return new Response(null, {
						status: 502,
						headers: { "Cache-Control": "no-store" },
					});
				}
			},
		},
	},
});

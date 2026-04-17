import { createFileRoute } from "@tanstack/react-router";
import { memoGet } from "../../../lib/flix-proxy.ts";
import { getAllLineNames } from "../../../lib/queries.ts";

const CACHE_CONTROL =
	"public, max-age=3600, s-maxage=86400, stale-while-revalidate=86400";

export const Route = createFileRoute("/api/picker/lines")({
	server: {
		handlers: {
			GET: async () => {
				const body = await memoGet("picker:lines", 300, getAllLineNames);
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

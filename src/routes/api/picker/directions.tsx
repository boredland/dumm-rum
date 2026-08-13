import { createFileRoute } from "@tanstack/react-router";
import { memoGet, PICKER_TTL_SEC } from "../../../lib/memo.ts";
import { getAllDirections } from "../../../lib/queries.ts";

const CACHE_CONTROL =
	"public, max-age=3600, s-maxage=86400, stale-while-revalidate=86400";

export const Route = createFileRoute("/api/picker/directions")({
	server: {
		handlers: {
			GET: async () => {
				const body = await memoGet(
					"picker:directions",
					PICKER_TTL_SEC,
					getAllDirections,
				);
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

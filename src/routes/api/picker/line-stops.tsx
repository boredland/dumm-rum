import { createFileRoute } from "@tanstack/react-router";
import { memoGet } from "../../../lib/memo.ts";
import { getDirectionsForLine, getStopsForLine } from "../../../lib/queries.ts";

/** Per-line pick-lists so the subscribe modal can narrow the Haltestelle
 * and Richtung dropdowns once a line is chosen. Cached slightly less
 * aggressively than the global lists because the line→stop map is derived
 * from 30-day activity and grows as new stops are discovered. */
const CACHE_CONTROL =
	"public, max-age=600, s-maxage=3600, stale-while-revalidate=3600";

export const Route = createFileRoute("/api/picker/line-stops")({
	server: {
		handlers: {
			GET: async ({ request }) => {
				const url = new URL(request.url);
				const line = (url.searchParams.get("line") ?? "").trim();
				if (!line) {
					return new Response(JSON.stringify({ stops: [], directions: [] }), {
						headers: {
							"Content-Type": "application/json",
							"Cache-Control": "public, max-age=60",
						},
					});
				}
				const body = await memoGet(
					`picker:line-stops:${line}`,
					300,
					async () => {
						const [stops, directions] = await Promise.all([
							getStopsForLine(line),
							getDirectionsForLine(line),
						]);
						return { stops, directions };
					},
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

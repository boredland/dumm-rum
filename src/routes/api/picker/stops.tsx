import { createFileRoute } from "@tanstack/react-router";
import { memoGet, PICKER_TTL_SEC } from "../../../lib/memo.ts";
import { getAllStopNames } from "../../../lib/queries.ts";

/** Heavy cache: the picklist of stops changes at most once per ingest pass
 * (every 5 min). A 1h browser cache + 1d CDN cache is fine because the
 * subscribe modal accepts freeform text for stops that aren't in the list,
 * so a stale list never breaks a subscription. */
const CACHE_CONTROL =
	"public, max-age=3600, s-maxage=86400, stale-while-revalidate=86400";

export const Route = createFileRoute("/api/picker/stops")({
	server: {
		handlers: {
			GET: async () => {
				const body = await memoGet(
					"picker:stops",
					PICKER_TTL_SEC,
					getAllStopNames,
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

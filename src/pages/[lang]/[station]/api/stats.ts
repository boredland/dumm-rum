import { env } from "cloudflare:workers";
import type { APIRoute } from "astro";
import { createDb } from "../../../../db/client";
import { getStats, parseFilter } from "../../../../lib/queries";
import { findStation, SLUG_REDIRECTS } from "../../../../lib/stations";

export const GET: APIRoute = async ({ params, url, redirect }) => {
	const slug = params.station!;
	const redirectSlug = SLUG_REDIRECTS[slug];
	if (redirectSlug)
		return redirect(
			`/${params.lang}/${redirectSlug}/api/stats${url.search}`,
			301,
		);
	const db = createDb(env.DB);
	const station = findStation(slug);
	if (!station) return new Response("Not found", { status: 404 });

	const filter = parseFilter(url);
	const stats = await getStats(db, station, filter);

	return Response.json(stats);
};

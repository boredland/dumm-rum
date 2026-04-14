import { env } from "cloudflare:workers";
import type { APIRoute } from "astro";
import { createDb } from "../../../../db/client";
import {
	findStopBySlug,
	getStopStats,
	parseFilter,
} from "../../../../lib/queries";
import {
	findStation,
	nameToSlug,
	SLUG_REDIRECTS,
} from "../../../../lib/stations";

export const GET: APIRoute = async ({ params, url, redirect }) => {
	const slug = params.station!;
	const redirectSlug = SLUG_REDIRECTS[slug];
	if (redirectSlug)
		return redirect(
			`/${params.lang}/${redirectSlug}/api/stats${url.search}`,
			301,
		);
	const db = createDb(env.DB);
	const configured = findStation(slug);
	const dynamicStop = configured
		? null
		: await findStopBySlug(db, slug, nameToSlug);
	if (!configured && !dynamicStop)
		return new Response("Not found", { status: 404 });

	const stopIds = configured ? [configured.id] : dynamicStop!.stopIds;
	const filter = parseFilter(url);
	const stats = await getStopStats(db, stopIds, filter);

	return Response.json(stats);
};

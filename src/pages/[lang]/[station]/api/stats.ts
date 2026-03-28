import { env } from "cloudflare:workers";
import type { APIRoute } from "astro";
import { createDb } from "../../../../db/client";
import { getStats, parseFilter } from "../../../../lib/queries";
import { findStation } from "../../../../lib/stations";

export const GET: APIRoute = async ({ params, url }) => {
	const db = createDb(env.DB);
	const station = findStation(params.station!);
	if (!station) return new Response("Not found", { status: 404 });

	const filter = parseFilter(url);
	const stats = await getStats(db, station, filter);

	return Response.json(stats);
};

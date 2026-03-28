import { env } from "cloudflare:workers";
import type { APIRoute } from "astro";
import { createDb } from "../../../../db/client";
import { getStats } from "../../../../lib/queries";
import { findStation } from "../../../../lib/stations";

export const GET: APIRoute = async ({ params, url }) => {
	const db = createDb(env.DB);
	const station = findStation(params.station!);
	if (!station) return new Response("Not found", { status: 404 });

	const coreOnly = url.searchParams.get("hours") === "core";
	const stats = await getStats(db, station, coreOnly);

	return Response.json(stats);
};

import { env } from "cloudflare:workers";
import type { APIRoute } from "astro";
import { runCollection } from "../../lib/collect";

export const GET: APIRoute = async ({ request }) => {
	const authHeader = request.headers.get("Authorization");
	if (authHeader !== `Bearer ${env.CRON_SECRET}`) {
		return new Response("Unauthorized", { status: 401 });
	}

	const summary = await runCollection(env.DB, env.AI, env.RMV_API_KEY);
	return Response.json(summary);
};

import { handle } from "@astrojs/cloudflare/handler";
import { createDb } from "./db/client";
import { runCollection } from "./lib/collect";
import { handleTelegramWebhook } from "./lib/telegram";

const CACHE_TTL = 300;

export default {
	async fetch(request: Request, env: Cloudflare.Env, ctx: ExecutionContext) {
		const url = new URL(request.url);
		if (
			url.pathname === `/api/telegram/${env.TELEGRAM_BOT_TOKEN}` &&
			request.method === "POST"
		) {
			const db = createDb(env.DB);
			const body = (await request.json()) as Parameters<
				typeof handleTelegramWebhook
			>[2];
			ctx.waitUntil(handleTelegramWebhook(db, env.TELEGRAM_BOT_TOKEN, body));
			return new Response("ok");
		}

		if (request.method === "GET") {
			const cache = (caches as unknown as { default: Cache }).default;
			const cached = await cache.match(request);
			if (cached) return cached;

			const response = await handle(request, env, ctx);
			const contentType = response.headers.get("content-type") ?? "";
			if (
				response.status === 200 &&
				(contentType.includes("text/html") ||
					contentType.includes("application/json"))
			) {
				response.headers.set(
					"Cache-Control",
					`public, s-maxage=${CACHE_TTL}, stale-while-revalidate=${CACHE_TTL}`,
				);
				ctx.waitUntil(cache.put(request, response.clone()));
			}
			return response;
		}

		return handle(request, env, ctx);
	},

	async scheduled(_controller: ScheduledController, env: Cloudflare.Env) {
		const db = createDb(env.DB);
		await runCollection(db, env.AI, env.RMV_API_KEY, env.TELEGRAM_BOT_TOKEN);
	},
} satisfies ExportedHandler<Cloudflare.Env>;

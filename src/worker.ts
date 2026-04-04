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
			const skipCache = request.headers.get("Cache-Purge") === "1";
			if (!skipCache) {
				const cached = await cache.match(request);
				if (cached) return cached;
			}

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

	async scheduled(
		_controller: ScheduledController,
		env: Cloudflare.Env,
		ctx: ExecutionContext,
	) {
		const db = createDb(env.DB);
		await runCollection(db, env.AI, env.RMV_API_KEY, env.TELEGRAM_BOT_TOKEN);

		const site = env.SITE_URL;
		if (site) {
			ctx.waitUntil(
				Promise.all(
					[`${site}/de`, `${site}/en`].map((url) =>
						fetch(url, { headers: { "Cache-Purge": "1" } }).catch(() => {}),
					),
				),
			);
		}
	},
} satisfies ExportedHandler<Cloudflare.Env>;

import { handle } from "@astrojs/cloudflare/handler";
import { createDb } from "./db/client";
import { runCollection } from "./lib/collect";
import { handleTelegramWebhook } from "./lib/telegram";

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
		return handle(request, env, ctx);
	},

	async scheduled(_controller: ScheduledController, env: Cloudflare.Env) {
		const db = createDb(env.DB);
		await runCollection(db, env.AI, env.RMV_API_KEY, env.TELEGRAM_BOT_TOKEN);
	},
} satisfies ExportedHandler<Cloudflare.Env>;

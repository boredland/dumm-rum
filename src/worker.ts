import { handle } from "@astrojs/cloudflare/handler";
import { createDb } from "./db/client";
import { runCollection } from "./lib/collect";

export default {
	fetch: handle,

	async scheduled(_controller: ScheduledController, env: Cloudflare.Env) {
		const db = createDb(env.DB);
		await runCollection(db, env.AI, env.RMV_API_KEY, env.SESSION);
	},
} satisfies ExportedHandler<Cloudflare.Env>;

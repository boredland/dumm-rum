import { handle } from "@astrojs/cloudflare/handler";
import { runCollection } from "./lib/collect";

export default {
	fetch: handle,

	async scheduled(_controller: ScheduledController, env: Cloudflare.Env) {
		await runCollection(env.DB, env.AI, env.RMV_API_KEY);
	},
} satisfies ExportedHandler<Cloudflare.Env>;

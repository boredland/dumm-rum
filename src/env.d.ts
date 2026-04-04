declare namespace Cloudflare {
	interface Env {
		DB: D1Database;
		AI: Ai;
		RMV_API_KEY: string;
		TELEGRAM_BOT_TOKEN: string;
		SITE_URL?: string;
	}
}

declare namespace Cloudflare {
	interface Env {
		DB: D1Database;
		AI: Ai;
		RMV_API_KEY: string;
		CRON_SECRET: string;
	}
}

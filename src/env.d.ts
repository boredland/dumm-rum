declare namespace Cloudflare {
	interface Env {
		DB: D1Database;
		AI: Ai;
		SESSION: KVNamespace;
		RMV_API_KEY: string;
	}
}

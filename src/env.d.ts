declare namespace Cloudflare {
	interface Env {
		DB: D1Database;
		AI: Ai;
		RMV_API_KEY: string;
		TELEGRAM_BOT_TOKEN: string;
		SITE_URL?: string;
		JOURNEY_QUEUE: Queue<JourneyPollMessage>;
	}
}

interface JourneyPollMessage {
	journeyRef: string;
	dayOfOperation: string;
	pollCount: number;
}

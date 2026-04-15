declare namespace Cloudflare {
	interface Env {
		DB: D1Database;
		AI: Ai;
		TELEGRAM_BOT_TOKEN: string;
		SITE_URL?: string;
		JOURNEY_QUEUE: Queue<JourneyPollMessage>;
	}
}

interface JourneyPollMessage {
	journeyRef: string;
	dayOfOperation: string;
	pollCount: number;
	// Consecutive mgate failures for this ref. REST is only attempted once
	// this passes MGATE_FALLBACK_THRESHOLD (see journeyPoller). Absent on
	// older in-flight messages — treat as 0.
	mgateFailCount?: number;
}

import type { Register } from "@tanstack/react-router";
import {
	createStartHandler,
	defaultStreamHandler,
	type RequestHandler,
} from "@tanstack/react-start/server";
import { warmHomeSummaries } from "./lib/home.ts";
import { warmPickerLists } from "./lib/memo.ts";
import {
	getAllDirections,
	getAllLineNames,
	getAllStopNames,
} from "./lib/queries.ts";
import { migrationsApplied, startIngest } from "./lib/workers.ts";

// Ingest startup runs alongside request handling rather than in front of
// it. Awaiting it here meant migrations, the known_stops backfill, pg-boss
// setup and a boot discovery all had to finish before serve.ts could open
// the listener, and the proxy answered 502 for that entire window — the
// deploy-time outage this ordering was meant to prevent.
//
// Failures still surface: nothing recovers from a broken ingest boot, so
// the process exits and the platform restarts it, rather than quietly
// serving a site whose data has silently stopped updating.
startIngest().catch((e) => {
	console.error("fatal: ingest startup failed:", e);
	process.exit(1);
});

// getStopSummaries costs ~1 s at prod scale; seed the memo at boot so the
// first post-deploy landing hit is served from cache. Sequenced behind
// migrations for the same reason requests are.
migrationsApplied()
	.then(warmHomeSummaries)
	.catch((e) => console.warn("home warmup failed:", e));

// The subscribe modal's three global pick-lists. getAllStopNames scans
// every known stop and cost ~29 s on the first request after a deploy —
// the one cold path the per-key caches never cover, because these keys are
// process-wide rather than per stop or line. Seeded alongside the home
// summaries so the first user after a restart hits a warm memo.
migrationsApplied()
	.then(() =>
		warmPickerLists({
			stops: getAllStopNames,
			lines: getAllLineNames,
			directions: getAllDirections,
		}),
	)
	.catch((e) => console.warn("picker warmup failed:", e));

const fetch = createStartHandler(defaultStreamHandler);

export type ServerEntry = { fetch: RequestHandler<Register> };

export default {
	async fetch(...args) {
		// The only part of startup a request genuinely depends on: a query
		// referencing a column its migration has not committed yet would
		// 500. Steady-state this resolves in ~1 ms and costs nothing; on a
		// deploy carrying a schema change it holds the request instead of
		// failing it. Everything else ingest does is irrelevant to readers.
		await migrationsApplied();
		return await fetch(...args);
	},
} satisfies ServerEntry;

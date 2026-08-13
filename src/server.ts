import type { Register } from "@tanstack/react-router";
import {
	createStartHandler,
	defaultStreamHandler,
	type RequestHandler,
} from "@tanstack/react-start/server";
import { getAggregatedVehicles } from "./lib/flix-proxy.ts";
import { warmHomeSummaries } from "./lib/home.ts";
import { memoGet } from "./lib/memo.ts";
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

// Fire-and-forget Flix aggregator warmup so the first user to hit
// `/api/flix/vehicles` gets a memo hit instead of a 15-25 s cold pool.
memoGet("vehicles", 25, getAggregatedVehicles).catch((e) =>
	console.warn("flix warmup failed:", e),
);

// getStopSummaries costs ~1 s at prod scale; seed the memo at boot so the
// first post-deploy landing hit is served from cache. Sequenced behind
// migrations for the same reason requests are.
migrationsApplied()
	.then(warmHomeSummaries)
	.catch((e) => console.warn("home warmup failed:", e));

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

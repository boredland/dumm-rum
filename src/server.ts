import type { Register } from "@tanstack/react-router";
import {
	createStartHandler,
	defaultStreamHandler,
	type RequestHandler,
} from "@tanstack/react-start/server";
import { getAggregatedVehicles, memoGet } from "./lib/flix-proxy.ts";
import { warmHomeSummaries } from "./lib/home.ts";
import { startIngest } from "./lib/workers.ts";

// Start pg-boss workers once per server process, alongside request
// handling. Top-level await blocks the server from accepting requests
// until workers are registered — which is what we want: first request
// hits a ready system.
await startIngest();

// Fire-and-forget Flix aggregator warmup so the first user to hit
// `/api/flix/vehicles` gets a memo hit instead of a 15-25 s cold pool.
memoGet("vehicles", 25, getAggregatedVehicles).catch((e) =>
	console.warn("flix warmup failed:", e),
);

// getStopSummaries runs ~5 s on prod; seed the memo at boot so the first
// post-deploy landing hit is served from cache.
warmHomeSummaries().catch((e) => console.warn("home warmup failed:", e));

const fetch = createStartHandler(defaultStreamHandler);

export type ServerEntry = { fetch: RequestHandler<Register> };

export default {
	async fetch(...args) {
		return await fetch(...args);
	},
} satisfies ServerEntry;

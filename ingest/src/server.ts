import type { Register } from "@tanstack/react-router";
import {
	createStartHandler,
	defaultStreamHandler,
	type RequestHandler,
} from "@tanstack/react-start/server";
import { startIngest } from "./lib/workers.ts";

// Start pg-boss workers once per server process, alongside request
// handling. Top-level await blocks the server from accepting requests
// until workers are registered — which is what we want: first request
// hits a ready system.
await startIngest();

const fetch = createStartHandler(defaultStreamHandler);

export type ServerEntry = { fetch: RequestHandler<Register> };

export default {
	async fetch(...args) {
		return await fetch(...args);
	},
} satisfies ServerEntry;

import type { Register } from "@tanstack/react-router";
import {
	createStartHandler,
	defaultStreamHandler,
	type RequestHandler,
} from "@tanstack/react-start/server";
import { startHomeWarmup } from "./lib/home.ts";
import { warmPickerLists } from "./lib/memo.ts";
import {
	getAllDirections,
	getAllLineNames,
	getAllStopNames,
} from "./lib/queries.ts";
import { warmEntityPages } from "./lib/warm.ts";
import {
	isLockTimeout,
	migrationsApplied,
	startIngest,
} from "./lib/workers.ts";

// Ingest startup runs alongside request handling rather than in front of
// it. Awaiting it here meant migrations, the known_stops backfill, pg-boss
// setup and a boot discovery all had to finish before serve.ts could open
// the listener, and the proxy answered 502 for that entire window — the
// deploy-time outage this ordering was meant to prevent.
//
// Failures still surface: nothing recovers from a broken ingest boot, so
// the process exits and the platform restarts it, rather than quietly
// serving a site whose data has silently stopped updating.
//
// Except when the reason is a migration that could not take its lock. That
// restart does not help — the next boot queues for the same lock behind the
// same poller — and it costs the site the container that was serving reads.
// Left up, the process keeps answering from a schema that is merely one
// migration behind, and the migration retries on the next deploy.
startIngest().catch((e) => {
	if (isLockTimeout(e)) {
		console.error(
			"ingest startup blocked on a migration lock; serving reads without ingest:",
			e,
		);
		return;
	}
	console.error("fatal: ingest startup failed:", e);
	process.exit(1);
});

// getStopSummaries costs ~1 s at prod scale; seed the memo at boot so the
// first post-deploy landing hit is served from cache. Sequenced behind
// migrations for the same reason requests are. Covers every window the day
// toggle offers and re-runs after each Berlin midnight, because the keys
// are pinned to yesterday's date and all go cold when it changes.
migrationsApplied()
	.then(startHomeWarmup)
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

// Pull every line and operator into Postgres's buffer cache. shared_buffers
// sits at its 128 MB default, too small to hold the working set, so the
// first visitor to each entity page paid a disk read: 2-5 s against
// production with a cold cache, against 0.12-0.16 s once the same page had
// been touched. Runs last and paced, so it fills the cache behind the
// warmups that serve the landing page.
migrationsApplied()
	.then(warmEntityPages)
	.catch((e) => console.warn("entity warmup failed:", e));

const fetch = createStartHandler(defaultStreamHandler);

export type ServerEntry = { fetch: RequestHandler<Register> };

/** How long a request will wait for a pending migration before being served
 * anyway.
 *
 * Requests used to await migrationsApplied() unbounded. The reasoning was
 * that a query touching a column its migration has not committed yet would
 * 500, and steady-state the await costs ~1 ms. Both are true, and it still
 * took the site down: a migration that rewrites journey_stops waits on an
 * ACCESS EXCLUSIVE lock the poller never releases, so "pending" lasted
 * forever and every request in front of it hit Cloudflare's timeout as a
 * 502. An origin that answers is worth more than one that is provably
 * consistent and unreachable — a stale-schema 500 affects the one route
 * that touches the new column; a hung await affects all of them. */
const MIGRATION_GATE_MS = 5_000;

export default {
	async fetch(...args) {
		// Resolves in ~1 ms once migrations have landed, which is the normal
		// case. The race only matters on a deploy whose migration is stuck.
		// .catch before the race, not after: Promise.race adopts a rejection
		// as its own, so a migration that gave up would otherwise reject
		// every request that waited on it — turning "one migration behind"
		// into "the whole site 500s", which is exactly the failure this gate
		// exists to prevent.
		await Promise.race([
			migrationsApplied().catch(() => {}),
			new Promise((r) => setTimeout(r, MIGRATION_GATE_MS)),
		]);
		return await fetch(...args);
	},
} satisfies ServerEntry;

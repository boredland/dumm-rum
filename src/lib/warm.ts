import {
	getAllLineNames,
	getLineStats,
	getOperatorStats,
	getOperatorSummaries,
} from "./queries.ts";

/** Pace between entity queries, so the sweep cannot starve real requests
 * of the connection pool on a small host. At ~10 ms per entity the whole
 * set still finishes in well under a minute. */
const GAP_MS = 25;

function sleep(ms: number): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setTimeout(resolve, ms);
	return promise;
}

/**
 * Reads every line and operator once at boot so their pages are served
 * from Postgres's buffer cache rather than from disk.
 *
 * The app's own SWR memos already cover repeat visits, but they are
 * per-key and in-process: the first visitor to each of ~106 lines and 16
 * operators still paid for a cold read. Measured against production with
 * an empty buffer cache that was 2-5 s, and 0.12-0.16 s once the same
 * pages had been touched — the gap is disk I/O, not query shape, because
 * shared_buffers is at its 128 MB default and cannot hold the working set.
 *
 * So this warms the *database* rather than the app: the entity pages'
 * index and heap pages end up resident, which also helps every other
 * query that touches the same rows. It is a mitigation, not a substitute
 * for sizing shared_buffers to the host — see the note in CLAUDE.md.
 *
 * Deliberately sequential and paced. The point is to populate a cache in
 * the background, not to race the first user; hammering the pool with 120
 * concurrent aggregates would make the very requests it is meant to help
 * slower. Failures are swallowed per entity: a warmup is an optimisation,
 * and one bad key must not take the boot down.
 */
export async function warmEntityPages(): Promise<void> {
	const started = Date.now();
	let warmed = 0;

	try {
		const operators = await getOperatorSummaries({ days: "all" });
		for (const o of operators) {
			try {
				await getOperatorStats(o.operator);
				warmed++;
			} catch {
				/* one entity failing must not stop the sweep */
			}
			await sleep(GAP_MS);
		}

		const lines = await getAllLineNames();
		for (const line of lines) {
			try {
				await getLineStats(line);
				warmed++;
			} catch {
				/* as above */
			}
			await sleep(GAP_MS);
		}
	} catch (e) {
		console.warn("entity warmup aborted:", e);
	}

	console.log(
		`entity warmup: ${warmed} entities in ${((Date.now() - started) / 1000).toFixed(1)}s`,
	);
}

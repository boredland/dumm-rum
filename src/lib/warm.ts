import { lineSwr, operatorSwr } from "./entity-cache.ts";
import { getAllLineNames, getOperatorSummaries } from "./queries.ts";

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
 * Populates the line and operator SWR memos at boot, so the first visitor
 * to an entity page after a deploy gets a cache hit rather than paying for
 * the aggregate.
 *
 * The memos are per-key and per-process, so every deploy emptied them and
 * the first request for each of ~106 lines and 16 operators ran the query
 * cold. Measured against production: 1.0-4.5 s on an untouched key against
 * 0.14-0.18 s once populated, with the worst cases on the operators that
 * carry the most runs.
 *
 * It goes through the memos deliberately, not the query functions. An
 * earlier version called the queries directly, which warmed Postgres's
 * cache but left the memos empty — and the memo miss, not the disk read,
 * is what the first visitor actually waits for.
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
				await operatorSwr.get(o.operator);
				warmed++;
			} catch {
				/* one entity failing must not stop the sweep */
			}
			await sleep(GAP_MS);
		}

		const lines = await getAllLineNames();
		for (const line of lines) {
			try {
				await lineSwr.get(line);
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

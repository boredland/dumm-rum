import {
	getLineStats,
	getOperatorStats,
	type LineStats,
	type OperatorStats,
} from "./queries.ts";
import { makeSwr } from "./swr.ts";

/**
 * SWR memos for the line and operator detail pages.
 *
 * These live here rather than beside their routes so the boot warmup can
 * populate the same instances the routes read. Defined in a route module
 * they were unreachable from `server.ts` — importing a route pulls in its
 * React component — so the warmup could only fill Postgres's cache, which
 * left the first visitor to each entity paying for the query itself.
 * Measured against production: 1.0-4.5 s on a key untouched since the last
 * deploy, 0.14-0.18 s once populated.
 *
 * One instance per process, module-scoped, exactly as before. The routes
 * import these rather than constructing their own.
 */
const SWR_OPTS = { freshMs: 60_000, staleMs: 15 * 60_000 } as const;

export const lineSwr = makeSwr<{ line: string; stats: LineStats }>(
	async (line) => ({ line, stats: await getLineStats(line) }),
	SWR_OPTS,
);

export const operatorSwr = makeSwr<{
	operator: string;
	stats: OperatorStats;
}>(
	async (operator) => ({ operator, stats: await getOperatorStats(operator) }),
	SWR_OPTS,
);

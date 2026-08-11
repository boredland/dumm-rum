/** Stale-while-revalidate cache for server-side loaders. Queries that
 * run ≥1 s at prod scale (entity aggregations over journey_runs /
 * journey_stops) should never be served synchronously — cold callers
 * wait once, everyone else rides the memo. */

interface Entry<T> {
	value: T;
	/** Return without refresh up to this timestamp. */
	fresh: number;
	/** Return cached + trigger background refresh up to this timestamp.
	 * Past it, the next caller blocks on a fresh fetch. */
	stale: number;
}

/** Most keys held per memo before the least-recently-used ones are
 * dropped. Keys come from route params (stop slug, line, operator, date),
 * so the space is unbounded and reachable by anyone typing URLs — without
 * a cap the map only ever grows. Well above the ~1300 stops or ~90 lines a
 * real working set touches, so eviction stays off the normal path. */
const MAX_ENTRIES = 4096;

/** Returns a keyed SWR memo. Pass a fetcher that computes the value for
 * a given string key; callers pass the same key to hit the cache. */
export function makeSwr<T>(
	fetcher: (key: string) => Promise<T>,
	opts: { freshMs: number; staleMs: number },
) {
	const memo = new Map<string, Entry<T>>();
	const inflight = new Map<string, Promise<T>>();

	/** Drops entries `get` can no longer use, then the oldest survivors if
	 * the map is still over cap. Past `stale` an entry is already dead
	 * weight — `get` blocks on a fresh fetch rather than return it — so
	 * sweeping those first evicts nothing anyone could have read. */
	function evict(now: number): void {
		for (const [k, e] of memo) if (e.stale <= now) memo.delete(k);
		// Map iterates in insertion order and refresh re-inserts, so the
		// front of the map is the least recently refreshed.
		for (const k of memo.keys()) {
			if (memo.size <= MAX_ENTRIES) break;
			memo.delete(k);
		}
	}

	function refresh(key: string): Promise<T> {
		const existing = inflight.get(key);
		if (existing) return existing;
		const p = fetcher(key)
			.then((value) => {
				const now = Date.now();
				// Delete before set so a refreshed key moves to the back of the
				// insertion order rather than keeping its original position.
				memo.delete(key);
				memo.set(key, {
					value,
					fresh: now + opts.freshMs,
					stale: now + opts.staleMs,
				});
				inflight.delete(key);
				if (memo.size > MAX_ENTRIES) evict(now);
				return value;
			})
			.catch((e) => {
				inflight.delete(key);
				throw e;
			});
		inflight.set(key, p);
		return p;
	}

	async function get(key: string): Promise<T> {
		const now = Date.now();
		const hit = memo.get(key);
		if (hit && hit.fresh > now) return hit.value;
		if (hit && hit.stale > now) {
			refresh(key).catch(() => {});
			return hit.value;
		}
		return refresh(key);
	}

	return { get, refresh };
}

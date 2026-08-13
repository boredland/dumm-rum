/** Stale-while-revalidate cache for server-side loaders. Queries that
 * run ≥1 s at prod scale (entity aggregations over journey_runs /
 * journey_stops) should never be served synchronously — cold callers
 * wait once, everyone else rides the memo. */

interface Entry<T> {
	value: T;
	/** Return without refresh up to this timestamp. */
	fresh: number;
	/** Past this the value is old enough to be worth logging about, but it
	 * is still served — a cached answer beats making somebody wait for the
	 * aggregate. Retained for eviction ordering and diagnostics. */
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

	/** Drops the least recently refreshed entries once the map is over cap.
	 *
	 * Purely capacity-based. It used to sweep everything past `stale` first,
	 * on the grounds that `get` would not return those anyway — but `get`
	 * now does return them while a refresh runs, so dropping them would
	 * reintroduce the blocking rebuild this cache exists to avoid. */
	function evict(): void {
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
				if (memo.size > MAX_ENTRIES) evict();
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
		if (hit) {
			// Stale, or past `stale` entirely: hand back what we have and let
			// the refresh land for whoever comes next. Blocking here meant any
			// page nobody had opened for staleMs paid the full aggregate —
			// which is most of the site most of the time, since there are ~154
			// entity pages and a 15 minute window.
			refresh(key).catch(() => {});
			return hit.value;
		}
		return refresh(key);
	}

	return { get, refresh };
}

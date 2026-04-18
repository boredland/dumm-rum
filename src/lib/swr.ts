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

/** Returns a keyed SWR memo. Pass a fetcher that computes the value for
 * a given string key; callers pass the same key to hit the cache. */
export function makeSwr<T>(
	fetcher: (key: string) => Promise<T>,
	opts: { freshMs: number; staleMs: number },
) {
	const memo = new Map<string, Entry<T>>();
	const inflight = new Map<string, Promise<T>>();

	function refresh(key: string): Promise<T> {
		const existing = inflight.get(key);
		if (existing) return existing;
		const p = fetcher(key)
			.then((value) => {
				const now = Date.now();
				memo.set(key, {
					value,
					fresh: now + opts.freshMs,
					stale: now + opts.staleMs,
				});
				inflight.delete(key);
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

/** Capacity bound shared by the in-process caches (`memo.ts`, `swr.ts`).
 *
 * Their keys come from route params — stop slug, line, operator, date,
 * picker query — so the space is unbounded and reachable by anyone typing
 * URLs. Well above the ~1300 stops or ~90 lines a real working set touches,
 * so eviction stays off the normal path. */
const MAX_ENTRIES = 4096;

/** Drops the least recently refreshed entries once `map` is over cap.
 *
 * Relies on the caller deleting a key before re-setting it on refresh:
 * Map iterates in insertion order, so with delete-before-set the front of
 * the map is the least recently refreshed.
 *
 * The early return keeps the normal path free of even an iterator
 * allocation, so callers can invoke this after every set rather than
 * guarding it themselves. */
export function evictOverCap<V>(map: Map<string, V>): void {
	if (map.size <= MAX_ENTRIES) return;
	for (const k of map.keys()) {
		if (map.size <= MAX_ENTRIES) break;
		map.delete(k);
	}
}

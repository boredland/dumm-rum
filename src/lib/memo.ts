/** TTL memo for JSON API responses, layered over the Postgres
 * `unlogged_cache` table so a fresh process (or a second replica) reuses
 * work an earlier one already paid for. Used by the picker endpoints
 * backing the subscribe modal. */

interface MemoEntry {
	body: string;
	expires: number;
}

const memo = new Map<string, MemoEntry>();

/** Returns cached JSON string when fresh; otherwise runs `build`,
 * JSON-encodes the result, stores, and returns. Errors from `build` are
 * not cached — they bubble up to the handler. */
export async function memoGet(
	key: string,
	ttlSec: number,
	build: () => Promise<unknown>,
): Promise<string> {
	const now = Date.now();
	const hit = memo.get(key);
	if (hit && hit.expires > now) return hit.body;

	// L2 lookup is lazy-imported so client bundles (which transitively
	// touch route modules importing this file) don't pull in the DB
	// client.
	try {
		const { cacheGet } = await import("./cache.ts");
		const fromKv = await cacheGet<unknown>(`memo:${key}`);
		if (fromKv !== null) {
			const body = JSON.stringify(fromKv);
			memo.set(key, { body, expires: now + ttlSec * 1000 });
			return body;
		}
	} catch {
		/* DB blip → fall through to upstream; surfaces as a cache miss */
	}

	const value = await build();
	const body = JSON.stringify(value);
	memo.set(key, { body, expires: now + ttlSec * 1000 });
	import("./cache.ts")
		.then(({ cachePut }) => cachePut(`memo:${key}`, value, ttlSec * 1000))
		.catch(() => {
			/* persistence failure is cosmetic — memo still holds the
			 * response for the process lifetime, subsequent polls just
			 * re-fetch on a cache miss. */
		});
	return body;
}

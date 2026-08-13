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

/** The process-wide picker lists, with the TTL their endpoints use.
 *
 * Declared here so the boot warmup and the request handlers cannot drift
 * onto different keys — a warmup that seeded `picker:stop` while the
 * handler read `picker:stops` would look fine and do nothing. */
export const PICKER_TTL_SEC = 300;

/** Seeds the global picker memos so the first request after a deploy is a
 * cache hit rather than a cold aggregate.
 *
 * getAllStopNames scans every known stop and cost ~29 s on the first
 * post-restart request in production, which is the last cold path the
 * per-key caches do not cover: the three lists below are process-wide, so
 * exactly one unlucky user paid for each after every deploy.
 *
 * Failures are swallowed per key. A warmup is an optimisation — if one
 * list cannot be built at boot the endpoint still builds it on demand, and
 * taking the process down for that would trade a slow request for an
 * outage. */
export async function warmPickerLists(builders: {
	stops: () => Promise<unknown>;
	lines: () => Promise<unknown>;
	directions: () => Promise<unknown>;
}): Promise<void> {
	await Promise.all(
		(
			[
				["picker:stops", builders.stops],
				["picker:lines", builders.lines],
				["picker:directions", builders.directions],
			] as const
		).map(([key, build]) =>
			memoGet(key, PICKER_TTL_SEC, build).catch((e) =>
				console.warn(`picker warmup failed for ${key}:`, e),
			),
		),
	);
}

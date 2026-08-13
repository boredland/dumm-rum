/** Stale-while-revalidate memo for JSON API responses, layered over the
 * Postgres `unlogged_cache` table so a fresh process (or a second replica)
 * reuses work an earlier one already paid for. Used by the picker
 * endpoints backing the subscribe modal.
 *
 * Past `expires` an entry is served anyway and refreshed in the
 * background. It used to block instead, which meant the caller who
 * happened to arrive after the TTL lapsed paid the full rebuild:
 * getAllStopNames scans every known stop and was measured at 28 s in
 * production, once every 300 s, on a process that had been up for
 * quarter of an hour. The data behind these lists changes at most once
 * per ingest pass and the modal accepts freeform text anyway, so serving
 * one stale response beats making somebody wait for a fresh one. */

interface MemoEntry {
	body: string;
	/** Serve without refreshing up to this timestamp. */
	expires: number;
}

const memo = new Map<string, MemoEntry>();
/** In-flight rebuilds, so a stale key refreshes once rather than once per
 * caller that arrives while it is running. */
const inflight = new Map<string, Promise<string>>();

/** Rebuilds `key` and stores the result, coalescing concurrent callers
 * onto one build. Errors are not cached — they reject every waiter and
 * leave whatever was memoized in place. */
function rebuild(
	key: string,
	ttlSec: number,
	build: () => Promise<unknown>,
): Promise<string> {
	const existing = inflight.get(key);
	if (existing) return existing;
	const p = (async () => {
		const value = await build();
		const body = JSON.stringify(value);
		memo.set(key, { body, expires: Date.now() + ttlSec * 1000 });
		import("./cache.ts")
			.then(({ cachePut }) => cachePut(`memo:${key}`, value, ttlSec * 1000))
			.catch(() => {
				/* persistence failure is cosmetic — the memo still holds the
				 * response for this process's lifetime. */
			});
		return body;
	})().finally(() => inflight.delete(key));
	inflight.set(key, p);
	return p;
}

/** Returns the cached JSON string, refreshing in the background once it is
 * past its TTL. Only a caller that finds nothing cached at all waits for a
 * build. */
export async function memoGet(
	key: string,
	ttlSec: number,
	build: () => Promise<unknown>,
): Promise<string> {
	const now = Date.now();
	const hit = memo.get(key);
	if (hit) {
		// Stale is fine: hand back what we have and let the refresh land for
		// whoever comes next.
		if (hit.expires <= now) {
			rebuild(key, ttlSec, build).catch((e) =>
				console.warn(`memo refresh failed for ${key}:`, e),
			);
		}
		return hit.body;
	}

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

	return rebuild(key, ttlSec, build);
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

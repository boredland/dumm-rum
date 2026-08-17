/**
 * Cheap Postgres-backed KV for recomputable responses. Currently the L2
 * layer behind `memo.ts`, which the picker endpoints use so a fresh
 * process reuses work an earlier one already paid for. Backs onto the
 * `unlogged_cache` table —
 * UNLOGGED = no WAL durability, but every value here can be recovered
 * from its upstream source on a cache miss.
 *
 * Values are stored as JSON strings; callers pick their own encoding.
 * `mget` batches multi-key lookups so pulling 50 polylines at once
 * costs one round trip rather than 50.
 */

import {
	and,
	eq,
	gt,
	inArray,
	isNotNull,
	isNull,
	lt,
	or,
	sql,
} from "drizzle-orm";
import { db } from "../db/client.ts";
import { unloggedCache } from "../db/schema.ts";

/** Fetch a single cached entry. Returns `null` on miss or when the row
 * has expired; callers must be prepared to repopulate via `put`. */
export async function cacheGet<T>(key: string): Promise<T | null> {
	const rows = await db
		.select({ value: unloggedCache.value })
		.from(unloggedCache)
		.where(
			and(
				eq(unloggedCache.key, key),
				or(
					isNull(unloggedCache.expiresAt),
					gt(unloggedCache.expiresAt, sql`now()`),
				),
			),
		)
		.limit(1);
	const raw = rows[0]?.value;
	if (raw == null) return null;
	try {
		return JSON.parse(raw) as T;
	} catch {
		return null;
	}
}

/** Fetch many cached entries in one round trip. Returns a Map so
 * callers can probe presence cheaply; absent keys aren't in the map. */
export async function cacheMGet<T>(keys: string[]): Promise<Map<string, T>> {
	const out = new Map<string, T>();
	if (keys.length === 0) return out;
	const rows = await db
		.select({ key: unloggedCache.key, value: unloggedCache.value })
		.from(unloggedCache)
		.where(
			and(
				inArray(unloggedCache.key, keys),
				or(
					isNull(unloggedCache.expiresAt),
					gt(unloggedCache.expiresAt, sql`now()`),
				),
			),
		);
	for (const row of rows) {
		try {
			out.set(row.key, JSON.parse(row.value) as T);
		} catch {
			/* drop corrupt entries silently — caller will refetch */
		}
	}
	return out;
}

/** Upsert a cached entry. `ttlMs` is optional; omit for entries that
 * live until the next explicit invalidation. Stored `value` is the
 * JSON-stringified `T`. */
export async function cachePut<T>(
	key: string,
	value: T,
	ttlMs?: number,
): Promise<void> {
	const json = JSON.stringify(value);
	const expiresAt =
		typeof ttlMs === "number" && ttlMs > 0
			? new Date(Date.now() + ttlMs)
			: null;
	await db
		.insert(unloggedCache)
		.values({ key, value: json, expiresAt })
		.onConflictDoUpdate({
			target: unloggedCache.key,
			set: {
				value: json,
				expiresAt,
				updatedAt: sql`now()`,
			},
		});
}

/** Drop an entry. No-op if the key isn't present. */
export async function cacheDelete(key: string): Promise<void> {
	await db.delete(unloggedCache).where(eq(unloggedCache.key, key));
}

/** Sweeps rows whose TTL has expired.
 *
 * Reads already filter on `expires_at`, so expired rows are invisible
 * but still occupy disk forever. Rows with a NULL `expiresAt` live until
 * explicitly invalidated and must never be swept. Returns the count of
 * removed rows. */
export async function cacheSweepExpired(): Promise<number> {
	const deleted = await db
		.delete(unloggedCache)
		.where(
			and(
				isNotNull(unloggedCache.expiresAt),
				lt(unloggedCache.expiresAt, sql`now()`),
			),
		)
		.returning({ key: unloggedCache.key });
	return deleted.length;
}

/**
 * bahn.expert live-GPS enrichment for DB long-distance trains.
 *
 * bahn.expert's backend surfaces real AVL positions (from DB's RIS
 * transports feed) through an undocumented tRPC endpoint that uses
 * devalue for serialization. We batch two procedures per poll:
 *  - `journey.find({journeyNumber, category, initialDepartureDate})` →
 *    resolves a train identity (e.g. `ICE 576` on 2026-04-18) to
 *    bahn.expert's internal `journeyId` uuid.
 *  - `journey.journeyPosition(journeyId)` → returns the latest GPS
 *    fix as `{longitude, latitude, time, speed}`.
 *
 * Both steps are batched: one GET request carries N find calls, a
 * second carries the M resolved positions. Typical shape at a Frankfurt
 * viewport: ~30 DB trains, 2 HTTP requests per 15 s poll (~8 req/min).
 *
 * Coverage is narrow: only DB Fernverkehr today (ICE/IC/EC/NJ/EN) —
 * DB Regio (RE/RB) and S-Bahn Rhein-Main return no position even when
 * the find succeeds. Matches are dropped in those cases; the map stays
 * honest with `hasGps: false` for untracked vehicles.
 */

import { parse, stringify } from "devalue";
import { cacheMGet, cachePut } from "./cache.ts";
import {
	closestPointIndex,
	distanceMeters,
	downsample,
	type GpsPath,
	sliceForward,
} from "./gps-path.ts";

const RPC_URL_BASE = "https://bahn.expert/rpc";

/** Request budget inside fetchVehicles. Two sequential batch calls
 * total, so each half gets 1.5 s. Tight but safe — single batched
 * journey.find of ~30 inputs completes in ~250 ms in testing. */
const FETCH_TIMEOUT_MS = 1_500;

/** Max trains per batched request. Keeps URL length under nginx-
 * typical 8 KB limits even with ~40-char devalue payloads. */
const MAX_BATCH = 50;

/** Categories bahn.expert publishes GPS for. Re-probed 2026-04-19:
 * Hessen RE / RB return null on practically every fix, but adjacent
 * national networks occasionally have AVL for the same category+number
 * combo (e.g. an SNCB RB in Belgium). We include RE + RB so the few
 * cross-border services that do traverse Rhein-Main get enriched; the
 * geographic sanity check in the map route's enrichment merge rejects
 * wrong-country matches so no marker ends up in Liège. */
const SUPPORTED_CATEGORIES = new Set([
	"ICE",
	"IC",
	"EC",
	"ECE",
	"NJ",
	"EN",
	"RJ",
	"RJX",
	"TGV",
	"RE",
	"RB",
]);

/** Rejection threshold when comparing bahn.expert's fix to the RMV
 * calc position during enrichment. HAFAS / GPS drift ~100-500 m, so
 * anything past ~20 km means we matched a same-number service on a
 * different network (most famously RE / RB share numbers with Belgian
 * / Swiss / Dutch regional classes). Exported so the map route can
 * reuse the constant. */
export const MAX_RMV_BAHN_EXPERT_DRIFT_M = 20_000;

export interface TrainIdentity {
	/** RMV-side index we'll hand the match back to. */
	rmvIndex: number;
	/** HAFAS category code, e.g. "ICE", "IC". Must be in SUPPORTED_CATEGORIES. */
	category: string;
	/** Train number, e.g. 576 for "ICE 576". */
	journeyNumber: number;
	/** Service date in `YYYY-MM-DD`. */
	serviceDate: string;
}

export interface BahnExpertPosition {
	rmvIndex: number;
	lat: number;
	lon: number;
	/** Unix ms of the fix timestamp (from bahn.expert's `time` field). */
	timeMs: number;
	/** Speed in m/s per bahn.expert's own units. Null when not provided. */
	speed: number | null;
	/** Forward trajectory for mid-poll animation. Built by slicing the
	 * train's full `journey.polyline` starting at the polyline vertex
	 * nearest to the fix, covering ~20 s worth of travel at `speed`.
	 * Null when the polyline fetch failed, the train is stationary, or
	 * we couldn't localise the fix on the polyline. */
	gpsPath: GpsPath | null;
}

/** How much wall-clock time the bahn.expert-derived path covers —
 * matches HEAG's 20 s window for consistency in the client animator. */
const BAHN_EXPERT_PATH_WINDOW_MS = 20_000;

/** Process-local L1 cache — polylines come from the Postgres
 * `unlogged_cache` table but we skip the DB hop on polls where we've
 * already fetched the journey this process lifetime. Each polyline is
 * stable for the service day so neither layer needs aggressive
 * eviction. */
const polylineL1 = new Map<string, [number, number][]>();

/** Same L1 idea for the journey.find resolver. Mapping from
 * `{category, journeyNumber, serviceDate}` → bahn.expert journeyId is
 * stable for the whole service day, so once resolved we never need
 * to ask again. */
const journeyIdL1 = new Map<string, string>();

/** Key prefix so the shared KV table is tidy and we can later GC old
 * journey-day polylines without scanning every row. */
const POLYLINE_KEY_PREFIX = "bahn-expert:polyline:";
const JOURNEY_ID_KEY_PREFIX = "bahn-expert:journey-id:";

/** TTL for persisted cache entries. A service day is typically <24 h
 * even for night services, so 36 h covers overlap without keeping
 * yesterday's data around forever. */
const BAHN_EXPERT_CACHE_TTL_MS = 36 * 60 * 60 * 1000;

/** Stable cache key for a train identity. */
function journeyIdKey(t: TrainIdentity): string {
	return `${t.category}|${t.journeyNumber}|${t.serviceDate}`;
}

export function isSupportedCategory(category: string): boolean {
	return SUPPORTED_CATEGORIES.has(category.trim().toUpperCase());
}

interface JourneyFindHit {
	journeyId: string;
	train?: {
		category?: string;
		journeyNumber?: number;
		transportType?: string;
	};
}

interface JourneyPositionHit {
	longitude: number;
	latitude: number;
	time: Date;
	speed?: number;
}

async function rpcBatch<T>(
	procedures: string[],
	inputs: unknown[],
): Promise<(T | null)[]> {
	if (procedures.length !== inputs.length) {
		throw new Error(
			`bahn-expert: procedure/input length mismatch ${procedures.length} vs ${inputs.length}`,
		);
	}
	if (procedures.length === 0) return [];

	const inputMap: Record<string, string> = {};
	for (let i = 0; i < inputs.length; i++) {
		inputMap[String(i)] = stringify(inputs[i]);
	}
	const url =
		`${RPC_URL_BASE}/${procedures.join(",")}?` +
		new URLSearchParams({ batch: "1", input: JSON.stringify(inputMap) });

	let resp: Response;
	try {
		resp = await fetch(url, {
			headers: { "User-Agent": "dummrum/1.0 (+https://dummrum.de)" },
			signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
		});
	} catch {
		return new Array(procedures.length).fill(null);
	}
	if (!resp.ok) return new Array(procedures.length).fill(null);

	let body: unknown;
	try {
		body = await resp.json();
	} catch {
		return new Array(procedures.length).fill(null);
	}
	if (!Array.isArray(body)) return new Array(procedures.length).fill(null);

	return body.map((entry) => {
		const item = entry as { result?: { data?: string }; error?: unknown };
		if (!item.result?.data) return null;
		try {
			return parse(item.result.data) as T;
		} catch {
			return null;
		}
	});
}

/** Resolve each train identity to bahn.expert's journeyId, hitting
 * the in-memory L1 first, then the Postgres KV, and finally the
 * `journey.find` RPC for whatever remains. Mappings are stable per
 * service day so we can cache for the full TTL. */
async function findJourneyIds(
	trains: TrainIdentity[],
): Promise<(string | null)[]> {
	const out: (string | null)[] = new Array(trains.length).fill(null);

	// L1: process-local Map.
	const missFromL1: { t: TrainIdentity; idx: number }[] = [];
	for (let i = 0; i < trains.length; i++) {
		const hit = journeyIdL1.get(journeyIdKey(trains[i]));
		if (hit) out[i] = hit;
		else missFromL1.push({ t: trains[i], idx: i });
	}
	if (missFromL1.length === 0) return out;

	// L2: Postgres unlogged_cache. One batched SELECT.
	let l2: Map<string, string>;
	try {
		l2 = await cacheMGet<string>(
			missFromL1.map((m) => JOURNEY_ID_KEY_PREFIX + journeyIdKey(m.t)),
		);
	} catch {
		l2 = new Map();
	}
	const stillMissing: { t: TrainIdentity; idx: number }[] = [];
	for (const m of missFromL1) {
		const kvKey = JOURNEY_ID_KEY_PREFIX + journeyIdKey(m.t);
		const fromKv = l2.get(kvKey);
		if (typeof fromKv === "string" && fromKv.length > 0) {
			journeyIdL1.set(journeyIdKey(m.t), fromKv);
			out[m.idx] = fromKv;
		} else {
			stillMissing.push(m);
		}
	}
	if (stillMissing.length === 0) return out;

	// L3: bahn.expert journey.find RPC. Batched.
	const inputs = stillMissing.map(({ t }) => ({
		journeyNumber: t.journeyNumber,
		category: t.category,
		initialDepartureDate: new Date(`${t.serviceDate}T00:00:00.000Z`),
	}));
	const results = await rpcBatch<JourneyFindHit[] | null>(
		stillMissing.map(() => "journey.find"),
		inputs,
	);
	for (let i = 0; i < stillMissing.length; i++) {
		const hits = results[i];
		const id =
			Array.isArray(hits) && hits.length > 0
				? (hits[0].journeyId ?? null)
				: null;
		if (!id) continue;
		const { t, idx } = stillMissing[i];
		journeyIdL1.set(journeyIdKey(t), id);
		out[idx] = id;
		// Fire-and-forget persistence.
		cachePut(
			JOURNEY_ID_KEY_PREFIX + journeyIdKey(t),
			id,
			BAHN_EXPERT_CACHE_TTL_MS,
		).catch(() => {
			/* surfaces as a re-fetch next poll — no user impact */
		});
	}
	return out;
}

async function fetchPositions(
	journeyIds: string[],
): Promise<(JourneyPositionHit | null)[]> {
	const procs = journeyIds.map(() => "journey.journeyPosition");
	const results = await rpcBatch<JourneyPositionHit | null>(procs, journeyIds);
	return results;
}

interface JourneyPolylineGeoJSON {
	type: string;
	coordinates: [number, number][];
}
interface JourneyPolylineResponse {
	geojsons?: JourneyPolylineGeoJSON[];
}

/** Fetch each journey's full polyline, checking the in-memory L1
 * cache first and then the Postgres KV. Only journeys missing from
 * both layers trigger a bahn.expert RPC; successful fetches warm both
 * caches. Returns `[lat, lon]` pairs aligned with `journeyIds`.
 *
 * Errors at either layer degrade gracefully — a DB outage means we
 * fall through to the RPC and still serve the map, and an RPC
 * failure just leaves the caller without gpsPath enrichment for that
 * train (it stays at its last poll's static fix). */
async function fetchPolylines(
	journeyIds: string[],
): Promise<(readonly [number, number][] | null)[]> {
	const out: (readonly [number, number][] | null)[] = new Array(
		journeyIds.length,
	).fill(null);
	const missFromL1: { id: string; idx: number }[] = [];
	for (let i = 0; i < journeyIds.length; i++) {
		const hit = polylineL1.get(journeyIds[i]);
		if (hit) out[i] = hit;
		else missFromL1.push({ id: journeyIds[i], idx: i });
	}
	if (missFromL1.length === 0) return out;

	// L2: Postgres KV. Batched SELECT so N missing journeys = 1 query.
	let l2: Map<string, [number, number][]>;
	try {
		l2 = await cacheMGet<[number, number][]>(
			missFromL1.map((m) => POLYLINE_KEY_PREFIX + m.id),
		);
	} catch {
		l2 = new Map();
	}
	const stillMissing: { id: string; idx: number }[] = [];
	for (const m of missFromL1) {
		const fromKv = l2.get(POLYLINE_KEY_PREFIX + m.id);
		if (fromKv && fromKv.length >= 2) {
			polylineL1.set(m.id, fromKv);
			out[m.idx] = fromKv;
		} else {
			stillMissing.push(m);
		}
	}
	if (stillMissing.length === 0) return out;

	// L3: bahn.expert RPC. Batched so N misses = 1 HTTP round trip.
	const results = await rpcBatch<JourneyPolylineResponse | null>(
		stillMissing.map(() => "journey.polyline"),
		stillMissing.map((m) => m.id),
	);
	for (let i = 0; i < stillMissing.length; i++) {
		const r = results[i];
		const raw = r?.geojsons?.[0]?.coordinates;
		if (!Array.isArray(raw) || raw.length < 2) continue;
		// GeoJSON is [lon, lat]; flip to our [lat, lon] convention.
		const flipped: [number, number][] = raw.map(([lon, lat]) => [lat, lon]);
		const id = stillMissing[i].id;
		polylineL1.set(id, flipped);
		out[stillMissing[i].idx] = flipped;
		// Fire-and-forget the DB write; don't block the map response
		// on its success.
		cachePut(POLYLINE_KEY_PREFIX + id, flipped, BAHN_EXPERT_CACHE_TTL_MS).catch(
			() => {
				/* surfaces on the next poll as a re-fetch — no user impact */
			},
		);
	}
	return out;
}

/** Build a forward-looking `GpsPath` slice from a journey's polyline
 * anchored at the real GPS fix. Returns null when we can't produce a
 * meaningful path (no polyline, train stationary / slower than 1 m/s,
 * fix too far from any polyline vertex). */
function buildGpsPath(
	polyline: readonly [number, number][] | null,
	fix: [number, number],
	speedMps: number | null,
): GpsPath | null {
	if (!polyline || polyline.length < 2) return null;
	if (speedMps == null || speedMps < 1) return null;
	const anchorIdx = closestPointIndex(polyline as [number, number][], fix);
	if (anchorIdx < 0) return null;
	// Sanity: fix shouldn't be > 500 m from the rail. If it is, the
	// polyline probably isn't the right one (bahn.expert occasionally
	// returns a stale / reused polyline) and a forward slice would
	// render the marker hundreds of metres off-track.
	if (distanceMeters(polyline[anchorIdx], fix) > 500) return null;
	const metersForWindow = speedMps * (BAHN_EXPERT_PATH_WINDOW_MS / 1000);
	const slice = sliceForward(
		polyline as [number, number][],
		anchorIdx,
		fix,
		metersForWindow,
	);
	if (slice.length < 2) return null;
	return {
		points: downsample(slice),
		windowMs: BAHN_EXPERT_PATH_WINDOW_MS,
	};
}

/** Resolve + fetch positions for a set of trains. Returns only the
 * entries where both the resolver and the position call succeeded.
 * Called ones that silently fail (null journeyId, null position) are
 * dropped rather than erroring — we always want to serve a map. */
export async function fetchBahnExpertPositions(
	trains: TrainIdentity[],
): Promise<BahnExpertPosition[]> {
	if (trains.length === 0) return [];
	// Clamp to MAX_BATCH to avoid URL-length issues. Under 50 trains is
	// typical for a Frankfurt viewport; if we ever blow past it, slice
	// rather than drop so every caller still gets some coverage.
	const batch = trains.slice(0, MAX_BATCH);

	const journeyIds = await findJourneyIds(batch);
	const withIds = batch
		.map((t, i) => ({ train: t, journeyId: journeyIds[i] }))
		.filter(
			(x): x is { train: TrainIdentity; journeyId: string } =>
				x.journeyId != null,
		);
	if (withIds.length === 0) return [];

	// Fetch positions and polylines in parallel. Polylines are heavy
	// (~300 kB per train uncompressed GeoJSON) but cache forever once
	// loaded, so the first poll for each new journey pays the cost
	// and subsequent polls hit the in-memory map.
	const [positions, polylines] = await Promise.all([
		fetchPositions(withIds.map((x) => x.journeyId)),
		fetchPolylines(withIds.map((x) => x.journeyId)),
	]);
	const out: BahnExpertPosition[] = [];
	for (let i = 0; i < withIds.length; i++) {
		const p = positions[i];
		if (!p) continue;
		const t = p.time;
		const timeMs = t instanceof Date ? t.getTime() : Number.NaN;
		if (!Number.isFinite(timeMs)) continue;
		const speed = typeof p.speed === "number" ? p.speed : null;
		out.push({
			rmvIndex: withIds[i].train.rmvIndex,
			lat: p.latitude,
			lon: p.longitude,
			timeMs,
			speed,
			gpsPath: buildGpsPath(polylines[i], [p.latitude, p.longitude], speed),
		});
	}
	return out;
}

/** Convert a 2-point motion vector into HAFAS dirGeo (0–31, 11.25° per
 * unit). When two consecutive fixes are too close (<5 m) we can't
 * infer a heading reliably; return null so the caller keeps the RMV
 * calc-based value instead. */
export function bearingFromMotion(
	from: { lat: number; lon: number },
	to: { lat: number; lon: number },
): number | null {
	const dLat = (to.lat - from.lat) * 111_000;
	const dLon =
		(to.lon - from.lon) * 111_000 * Math.cos((from.lat * Math.PI) / 180);
	const distM = Math.sqrt(dLat * dLat + dLon * dLon);
	if (distM < 5) return null;
	const deg = (Math.atan2(dLon, dLat) * 180) / Math.PI;
	return ((deg + 360) % 360) / 11.25;
}

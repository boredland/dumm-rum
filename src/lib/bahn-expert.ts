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

const RPC_URL_BASE = "https://bahn.expert/rpc";

/** Request budget inside fetchVehicles. Two sequential batch calls
 * total, so each half gets 1.5 s. Tight but safe — single batched
 * journey.find of ~30 inputs completes in ~250 ms in testing. */
const FETCH_TIMEOUT_MS = 1_500;

/** Max trains per batched request. Keeps URL length under nginx-
 * typical 8 KB limits even with ~40-char devalue payloads. */
const MAX_BATCH = 50;

/** Categories bahn.expert publishes GPS for. Tested 2026-04-18:
 * Fernverkehr always returns position where journey matches; DB Regio
 * (RE/RB) and S-Bahn always return null. Expand this set if/when we
 * see positions for them. */
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
]);

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

async function findJourneyIds(
	trains: TrainIdentity[],
): Promise<(string | null)[]> {
	const procs = trains.map(() => "journey.find");
	const inputs = trains.map((t) => ({
		journeyNumber: t.journeyNumber,
		category: t.category,
		initialDepartureDate: new Date(`${t.serviceDate}T00:00:00.000Z`),
	}));
	const results = await rpcBatch<JourneyFindHit[] | null>(procs, inputs);
	return results.map((hits) => {
		if (!Array.isArray(hits) || hits.length === 0) return null;
		return hits[0].journeyId ?? null;
	});
}

async function fetchPositions(
	journeyIds: string[],
): Promise<(JourneyPositionHit | null)[]> {
	const procs = journeyIds.map(() => "journey.journeyPosition");
	const results = await rpcBatch<JourneyPositionHit | null>(procs, journeyIds);
	return results;
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

	const positions = await fetchPositions(withIds.map((x) => x.journeyId));
	const out: BahnExpertPosition[] = [];
	for (let i = 0; i < withIds.length; i++) {
		const p = positions[i];
		if (!p) continue;
		const t = p.time;
		const timeMs = t instanceof Date ? t.getTime() : Number.NaN;
		if (!Number.isFinite(timeMs)) continue;
		out.push({
			rmvIndex: withIds[i].train.rmvIndex,
			lat: p.latitude,
			lon: p.longitude,
			timeMs,
			speed: typeof p.speed === "number" ? p.speed : null,
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

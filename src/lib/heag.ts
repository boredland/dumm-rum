/**
 * HEAG mobilo live-GPS enrichment. HEAG runs Darmstadt's trams + buses
 * and exposes real AVL positions at `service.ivanto.de/srs/...` (same
 * backend their branded Livemap uses at heagmobilo-live.geomobile.de).
 *
 * Flow: fetch the global HEAG feed once per mgate poll, match each
 * HEAG vehicle to an RMV `Vehicle` by line + direction + nearest
 * calc-position, then hand the match back to the map route which
 * overwrites lat/lon/heading/hasGps/gpsFixAt on the paired entry.
 * Unmatched HEAG vehicles are dropped — we only enrich existing RMV
 * journeys, never introduce duplicates.
 */

import { toDirGeo } from "./flix-proxy.ts";

const HEAG_URL =
	"https://service.ivanto.de/srs/api/v1/vehiclelivedata?tenant=heag";

export interface HeagVehicle {
	date: string;
	line: string;
	lineId: string;
	direction: string;
	latitude: number;
	longitude: number;
	bearing: number;
	vehicleId: number;
	category: number;
	type: number;
	status: number;
	deviation: number;
	offline: boolean;
}

interface HeagResponse {
	vehicles: HeagVehicle[];
}

/** Minimal RMV vehicle shape we need for matching — subset of the full
 * `Vehicle` type that the map route uses. Keeps this module decoupled
 * from the route's internal types. */
export interface MatchableVehicle {
	name: string;
	direction: string;
	lat: number;
	lon: number;
}

/** Timeout: the HEAG call sits inside our mgate path, so a hang would
 * block the whole map poll. 2.5 s is tight but safe — the feed is
 * single-POP and typically returns in <300 ms. */
const FETCH_TIMEOUT_MS = 2_500;

export async function fetchHeagVehicles(): Promise<HeagVehicle[]> {
	try {
		const resp = await fetch(HEAG_URL, {
			headers: { "User-Agent": "dummrum/1.0 (+https://dummrum.de)" },
			signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
		});
		if (!resp.ok) return [];
		const json = (await resp.json()) as HeagResponse;
		return json.vehicles ?? [];
	} catch {
		return [];
	}
}

const EARTH_M_PER_DEG = 111_000;

function distMeters(
	a: { lat: number; lon: number },
	b: { lat: number; lon: number },
): number {
	const dLat = (a.lat - b.lat) * EARTH_M_PER_DEG;
	const dLon =
		(a.lon - b.lon) * EARTH_M_PER_DEG * Math.cos((a.lat * Math.PI) / 180);
	return Math.sqrt(dLat * dLat + dLon * dLon);
}

/** Strip RMV's category prefix ("Bus H", "Tram 1", "Straßenbahn 3") so
 * we can compare purely on the line token. HEAG's `line` field is
 * already bare ("H", "1", "693"). */
function stripCategoryPrefix(name: string): string {
	return name
		.trim()
		.replace(/^(Bus|Tram|Straßenbahn|Str|U-Bahn|U|RE|RB|S|RT|RMV)\s+/i, "")
		.trim();
}

/** Direction-text normalisation: lower-case, collapse whitespace, drop
 * tokens that the two sources express differently. HEAG emits "Darmstadt
 * Haasstraße"; RMV emits "Darmstadt Haasstraße" too — but some lines
 * prefix the city ("Darmstadt-Kranichstein" vs "Kranichstein"). Comparing
 * just the distinctive trailing token handles both. */
function directionTokens(dir: string): string[] {
	return dir
		.toLowerCase()
		.replace(/[^a-z0-9äöüß\s-]/g, " ")
		.replace(/-/g, " ")
		.split(/\s+/)
		.filter((t) => t.length > 2);
}

function directionMatches(a: string, b: string): boolean {
	const at = directionTokens(a);
	const bt = directionTokens(b);
	if (at.length === 0 || bt.length === 0) return false;
	// Match on the distinctive last token (usually the stop name); this
	// accepts "Kranichstein Kesselhutweg" vs "Darmstadt-Kranichstein
	// Kesselhutweg" because both end on the same token.
	return at[at.length - 1] === bt[bt.length - 1];
}

/** Proximity threshold for breaking ties when multiple RMV vehicles
 * run the same line+direction. HEAG's real GPS should be within a few
 * hundred metres of the *correct* RMV calc position at any given
 * moment; 5 km is a safety margin that still excludes a same-line
 * vehicle on the opposite end of the city. */
const MAX_MATCH_DISTANCE_M = 5_000;

export interface HeagMatch {
	/** Index into the `rmv` array the caller passed in. */
	rmvIndex: number;
	/** HEAG-supplied fresh data for that vehicle. */
	heag: HeagVehicle;
	/** Distance from HEAG's GPS to RMV's calc in metres, for debugging. */
	distance: number;
}

/** Pair each HEAG vehicle with at most one RMV vehicle. Strategy:
 * - filter RMV candidates by matching line + direction last-token,
 * - pick the candidate closest to the HEAG GPS fix (≤5 km),
 * - return one match per HEAG vehicle; unmatched HEAGs are dropped.
 * Never returns the same `rmvIndex` twice — if two HEAG vehicles both
 * want the same RMV entry (which shouldn't happen but can during
 * naming edge cases), the closer one wins. */
export function matchHeagToRmv(
	rmv: MatchableVehicle[],
	heag: HeagVehicle[],
): HeagMatch[] {
	const claimed = new Map<number, HeagMatch>();

	for (const h of heag) {
		if (h.offline) continue;
		const hPos = { lat: h.latitude, lon: h.longitude };
		let best: HeagMatch | null = null;
		for (let i = 0; i < rmv.length; i++) {
			const r = rmv[i];
			if (stripCategoryPrefix(r.name).toLowerCase() !== h.line.toLowerCase())
				continue;
			if (!directionMatches(r.direction, h.direction)) continue;
			const d = distMeters(hPos, r);
			if (d > MAX_MATCH_DISTANCE_M) continue;
			if (!best || d < best.distance) {
				best = { rmvIndex: i, heag: h, distance: d };
			}
		}
		if (!best) continue;
		const prior = claimed.get(best.rmvIndex);
		if (!prior || best.distance < prior.distance) {
			claimed.set(best.rmvIndex, best);
		}
	}

	return [...claimed.values()];
}

/** Compute the unix-ms timestamp HEAG's `date` string represents.
 * Returns null on parse failure so callers can fall back cleanly. */
export function parseHeagFixTime(date: string): number | null {
	const t = Date.parse(date);
	return Number.isFinite(t) ? t : null;
}

/** Convert HEAG's 0–360° bearing into HAFAS's `dirGeo` 0–31 scale the
 * map's icon code expects. */
export function heagHeadingToDirGeo(bearing: number): number {
	return toDirGeo(bearing);
}

/**
 * Livemap feeder for KVV. Queries active `journey_runs` with the
 * `kvv|…` prefix, joins per-stop realtime times + coords from
 * `journey_stops`, and computes a current position for each run by:
 *   1. Finding the two adjacent stops the vehicle is currently
 *      travelling between (or "at" if dwelling or not yet departed).
 *   2. Interpolating position along the cached line polyline if we
 *      have one (same polyline the bahn.expert path uses —
 *      `[lat, lon][]` in `gps-path.ts` units), else falling back to
 *      straight-line between the two stops.
 * Returns `Vehicle[]` in the shape the existing livemap code renders.
 *
 * No real GPS — Karlsruhe's AVL was shut down in 2021 — so
 * `hasGps: false` and `gpsFixAt: null` on every entry. `hasRT` stays
 * honest: true only when at least one stop has observed realtime
 * (non-null `rt_dep_time` / `rt_arr_time`).
 */

import { and, eq, inArray, like, sql } from "drizzle-orm";
import { db } from "../db/client.ts";
import { journeyRuns, journeyStops } from "../db/schema.ts";
import { cacheMGet } from "./cache.ts";
import {
	closestPointIndex,
	locationAtPercent,
	sliceForward,
} from "./gps-path.ts";
import {
	decodeTripRef,
	shapeCacheKey,
	shapeFromL1,
	shapeToL1,
} from "./kvv-efa.ts";
import { berlinTime, nowBerlin, todayBerlin } from "./utils.ts";

interface Waypoint {
	lat: number;
	lon: number;
	t: number;
	heading: number;
}

export interface KvvMapVehicle {
	id: string;
	name: string;
	lat: number;
	lon: number;
	direction: string;
	heading: number;
	category: string;
	operator: string;
	bg: string;
	delay: number | null;
	occupancy: null;
	hasRT: boolean;
	hasGps: false;
	gpsFixAt: null;
	gpsPath: null;
	stationary: boolean;
	externalTrackingUrl: null;
	serviceDate: string | null;
	waypoints: Waypoint[];
	fetchedAt: number;
}

/** Match the livemap's RMV category colours so KVV markers are
 * visually consistent with an adjacent RMV vehicle of the same mode.
 * Kept inline (rather than imported from the map route) so the ingest
 * side stays independent of the client bundle. */
const CATEGORY_COLORS: Record<string, string> = {
	Tram: "#ef7d00",
	Bus: "#a71680",
	"U-Bahn": "#0065ae",
	"S-Bahn": "#009757",
	Regionalverkehr: "#EC0016",
	Fernverkehr: "#EC0016",
	Other: "#666",
};

/** Equirectangular bearing (degrees, 0 = north, clockwise). Cheap
 * enough for per-marker heading; caller-visible value is integer
 * so tiny per-frame flutter doesn't trigger re-renders of the icon
 * string cache keyed on heading. */
function bearingDeg(from: [number, number], to: [number, number]): number {
	const [lat1, lon1] = from;
	const [lat2, lon2] = to;
	const dLat = (lat2 - lat1) * 111_000;
	const cosLat = Math.cos((lat1 * Math.PI) / 180);
	const dLon = (lon2 - lon1) * 111_000 * cosLat;
	if (dLat === 0 && dLon === 0) return 0;
	const rad = Math.atan2(dLon, dLat);
	const deg = (rad * 180) / Math.PI;
	return Math.round(((deg % 360) + 360) % 360);
}

/** Scheduled vs. realtime delay at a stop, in minutes — sign-preserving.
 * Returns null when either side is missing. Matches `delayMin()` in
 * `utils.ts` but inlined here so we can compute directly off an in-
 * memory row without going through the Date constructor for every
 * polled stop (discover + poll run against hundreds of rows). */
function delayMinutes(
	date: string,
	sched: string | null,
	rt: string | null,
): number | null {
	if (!sched || !rt) return null;
	const s = berlinTime(date, sched);
	const r = berlinTime(date, rt);
	if (!s.isValid() || !r.isValid()) return null;
	return Math.round(r.diff(s, "minute", true));
}

/** Pick whichever of (rtDepTime, depTime, rtArrTime, arrTime) exists,
 * preferring realtime when present. The caller cares about a single
 * "canonical" time per stop for current-segment lookup; we'd rather be
 * slightly wrong about which direction the value came from than skip
 * the stop entirely because one field happens to be null. */
function canonicalTime(s: {
	rtDepTime: string | null;
	depTime: string | null;
	rtArrTime: string | null;
	arrTime: string | null;
}): string | null {
	return s.rtDepTime ?? s.depTime ?? s.rtArrTime ?? s.arrTime ?? null;
}

interface RunRow {
	journeyRef: string;
	dayOfOperation: string;
	line: string;
	category: string | null;
	operator: string | null;
	destName: string;
	originDepTime: string;
	destArrTime: string;
	wasTracked: boolean;
	cancelled: boolean;
}

interface StopRow {
	journeyRef: string;
	routeIdx: number;
	stopName: string;
	depTime: string | null;
	arrTime: string | null;
	rtDepTime: string | null;
	rtArrTime: string | null;
	lat: number | null;
	lon: number | null;
}

interface Bbox {
	swLat: number;
	swLon: number;
	neLat: number;
	neLon: number;
}

function inBbox(lat: number, lon: number, b: Bbox): boolean {
	return lat >= b.swLat && lat <= b.neLat && lon >= b.swLon && lon <= b.neLon;
}

/** Load shapes for a batch of statelesses, hitting L1 first and the
 * Postgres cache for the rest. Absent entries stay absent in the
 * returned map; callers interpret that as "no polyline yet, use
 * straight-line fallback" rather than an error. */
async function loadShapes(
	statelesses: string[],
): Promise<Map<string, [number, number][]>> {
	const out = new Map<string, [number, number][]>();
	const missing: string[] = [];
	for (const s of statelesses) {
		const l1 = shapeFromL1(s);
		if (l1) out.set(s, l1);
		else missing.push(s);
	}
	if (missing.length === 0) return out;
	const keyToStateless = new Map(missing.map((s) => [shapeCacheKey(s), s]));
	const l2 = await cacheMGet<[number, number][]>([...keyToStateless.keys()]);
	for (const [k, v] of l2) {
		const stateless = keyToStateless.get(k);
		if (!stateless || !Array.isArray(v) || v.length === 0) continue;
		out.set(stateless, v);
		shapeToL1(stateless, v);
	}
	return out;
}

/** Compute the current lat/lon of a run by finding the "current leg"
 * between stops and interpolating. Returns null when the run has no
 * timed stops (shouldn't happen in practice) or when `now` is outside
 * the run's time envelope. */
function computePosition(
	runDay: string,
	stops: StopRow[],
	nowMs: number,
	shape: [number, number][] | undefined,
): {
	lat: number;
	lon: number;
	heading: number;
	stationary: boolean;
	passedCount: number;
} | null {
	const timed = stops
		.filter((s) => s.lat != null && s.lon != null)
		.map((s) => {
			const t = canonicalTime(s);
			const tMs = t ? berlinTime(runDay, t).valueOf() : null;
			return { s, tMs };
		})
		.filter((e): e is { s: StopRow; tMs: number } => e.tMs != null);

	if (timed.length < 2) return null;

	// Already arrived / not yet departed edge cases.
	if (nowMs < timed[0].tMs) {
		const { s } = timed[0];
		return {
			lat: s.lat as number,
			lon: s.lon as number,
			heading: bearingDeg(
				[s.lat as number, s.lon as number],
				[timed[1].s.lat as number, timed[1].s.lon as number],
			),
			stationary: true,
			passedCount: 0,
		};
	}
	const last = timed[timed.length - 1];
	if (nowMs > last.tMs) return null;

	// Binary-ish linear scan (few dozen stops max — not worth fancier).
	let segIdx = 0;
	for (let i = 0; i < timed.length - 1; i++) {
		if (timed[i].tMs <= nowMs && nowMs <= timed[i + 1].tMs) {
			segIdx = i;
			break;
		}
	}

	const a = timed[segIdx];
	const b = timed[segIdx + 1];
	const totalMs = Math.max(1, b.tMs - a.tMs);
	const elapsed = Math.max(0, Math.min(totalMs, nowMs - a.tMs));
	const ratio = elapsed / totalMs;

	const aLatLon: [number, number] = [a.s.lat as number, a.s.lon as number];
	const bLatLon: [number, number] = [b.s.lat as number, b.s.lon as number];

	if (!shape || shape.length < 2) {
		// Straight-line fallback between stops.
		return {
			lat: aLatLon[0] + (bLatLon[0] - aLatLon[0]) * ratio,
			lon: aLatLon[1] + (bLatLon[1] - aLatLon[1]) * ratio,
			heading: bearingDeg(aLatLon, bLatLon),
			stationary: false,
			passedCount: segIdx,
		};
	}

	// Polyline-aware interpolation. Find each stop's nearest polyline
	// vertex, walk the sub-slice between them by time ratio. `sliceForward`
	// gives us the distance along the polyline the slice needs to cover,
	// from which `locationAtPercent` returns the exact point.
	const idxA = closestPointIndex(shape, aLatLon);
	const idxB = closestPointIndex(shape, bLatLon);
	if (idxA < 0 || idxB < 0 || idxA === idxB) {
		return {
			lat: aLatLon[0] + (bLatLon[0] - aLatLon[0]) * ratio,
			lon: aLatLon[1] + (bLatLon[1] - aLatLon[1]) * ratio,
			heading: bearingDeg(aLatLon, bLatLon),
			stationary: false,
			passedCount: segIdx,
		};
	}
	const lo = Math.min(idxA, idxB);
	const hi = Math.max(idxA, idxB);
	// Directional slice. If the stops appear in polyline order A→B, ratio
	// walks forward; if they're reversed (inbound/outbound on a two-way
	// route sharing geometry), we flip.
	const subline =
		idxA <= idxB ? shape.slice(lo, hi + 1) : shape.slice(lo, hi + 1).reverse();
	if (subline.length < 2) {
		return {
			lat: aLatLon[0] + (bLatLon[0] - aLatLon[0]) * ratio,
			lon: aLatLon[1] + (bLatLon[1] - aLatLon[1]) * ratio,
			heading: bearingDeg(aLatLon, bLatLon),
			stationary: false,
			passedCount: segIdx,
		};
	}
	const pos = locationAtPercent(subline, ratio * 100);
	// Heading: short look-ahead along the same subline (~50 m) so the
	// heading tracks the curve rather than the stop-to-stop bearing.
	const ahead = sliceForward(subline, 0, pos, 50);
	const heading =
		ahead.length >= 2
			? bearingDeg(ahead[0], ahead[ahead.length - 1])
			: bearingDeg(aLatLon, bLatLon);

	return {
		lat: pos[0],
		lon: pos[1],
		heading,
		stationary: false,
		passedCount: segIdx,
	};
}

/**
 * Main entry point — returns current positions of every active KVV
 * journey that has at least one stop inside `bbox`. Takes the viewport
 * bbox and the current `Date`; everything else comes from Postgres
 * + the polyline cache.
 */
export async function getActiveKvvVehicles(
	bbox: Bbox,
	now: Date = new Date(),
): Promise<KvvMapVehicle[]> {
	const today = todayBerlin();
	const nowBerl = nowBerlin();
	const windowStart = nowBerl.subtract(5, "minute").format("HH:mm:ss");
	const windowEnd = nowBerl.add(30, "minute").format("HH:mm:ss");

	// Active runs today: origin departs within the next 30 min OR dest
	// has arrived within the last 5 min. Covers the window the livemap
	// wants to render, with the same ~35-minute horizon the RMV feed
	// uses in practice.
	const activeRuns = (await db
		.select({
			journeyRef: journeyRuns.journeyRef,
			dayOfOperation: journeyRuns.dayOfOperation,
			line: journeyRuns.line,
			category: journeyRuns.category,
			operator: journeyRuns.operator,
			destName: journeyRuns.destName,
			originDepTime: journeyRuns.originDepTime,
			destArrTime: journeyRuns.destArrTime,
			wasTracked: journeyRuns.wasTracked,
			cancelled: journeyRuns.cancelled,
		})
		.from(journeyRuns)
		.where(
			and(
				eq(journeyRuns.dayOfOperation, today),
				like(journeyRuns.journeyRef, "kvv|%"),
				sql`${journeyRuns.originDepTime} <= ${windowEnd}`,
				sql`${journeyRuns.destArrTime} >= ${windowStart}`,
			),
		)) as RunRow[];

	if (activeRuns.length === 0) return [];

	// One query for all stops across the active runs — cheaper than
	// the per-run fan-out the discover code uses, because we want every
	// stop for bbox filtering + segment lookup anyway.
	const refs = activeRuns.map((r) => r.journeyRef);
	const stopRows = (await db
		.select({
			journeyRef: journeyStops.journeyRef,
			routeIdx: journeyStops.routeIdx,
			stopName: journeyStops.stopName,
			depTime: journeyStops.depTime,
			arrTime: journeyStops.arrTime,
			rtDepTime: journeyStops.rtDepTime,
			rtArrTime: journeyStops.rtArrTime,
			lat: journeyStops.lat,
			lon: journeyStops.lon,
		})
		.from(journeyStops)
		.where(
			and(
				inArray(journeyStops.journeyRef, refs),
				eq(journeyStops.dayOfOperation, today),
			),
		)) as StopRow[];

	const stopsByRef = new Map<string, StopRow[]>();
	for (const s of stopRows) {
		const arr = stopsByRef.get(s.journeyRef);
		if (arr) arr.push(s);
		else stopsByRef.set(s.journeyRef, [s]);
	}
	for (const arr of stopsByRef.values())
		arr.sort((x, y) => x.routeIdx - y.routeIdx);

	// bbox filter: drop any run whose stops don't intersect the
	// viewport. Shapes often extend beyond the stop list so we
	// conservatively check only stops, not polyline vertices — the
	// miss rate on a viewport-sized query is small.
	const qualifying: RunRow[] = [];
	for (const run of activeRuns) {
		const stops = stopsByRef.get(run.journeyRef);
		if (!stops) continue;
		if (
			stops.some(
				(s) => s.lat != null && s.lon != null && inBbox(s.lat, s.lon, bbox),
			)
		) {
			qualifying.push(run);
		}
	}
	if (qualifying.length === 0) return [];

	// Gather the distinct statelesses whose shapes we'll need, batch-
	// load them. Runs on the same line-direction share a polyline so
	// the dedupe is effective (typically 10-20 statelesses for 50+ runs).
	const statelesses = new Set<string>();
	for (const r of qualifying) {
		const d = decodeTripRef(r.journeyRef);
		if (d) statelesses.add(d.stateless);
	}
	const shapes = await loadShapes([...statelesses]);

	const nowMs = now.getTime();
	const fetchedAt = nowMs;
	const vehicles: KvvMapVehicle[] = [];

	for (const run of qualifying) {
		const stops = stopsByRef.get(run.journeyRef);
		if (!stops) continue;
		const decoded = decodeTripRef(run.journeyRef);
		const shape = decoded ? shapes.get(decoded.stateless) : undefined;
		const pos = computePosition(run.dayOfOperation, stops, nowMs, shape);
		if (!pos) continue;

		// Delay — first upcoming stop with both scheduled + realtime
		// tells us how late the vehicle is relative to schedule right
		// now. Fall back to last passed stop when there's no upcoming
		// realtime signal (end of trip, or schedule-only segment).
		let delay: number | null = null;
		for (let i = pos.passedCount; i < stops.length; i++) {
			const d = delayMinutes(
				run.dayOfOperation,
				stops[i].depTime ?? stops[i].arrTime,
				stops[i].rtDepTime ?? stops[i].rtArrTime,
			);
			if (d != null) {
				delay = d;
				break;
			}
		}
		if (delay == null && pos.passedCount > 0) {
			const prev = stops[pos.passedCount];
			delay = delayMinutes(
				run.dayOfOperation,
				prev.depTime ?? prev.arrTime,
				prev.rtDepTime ?? prev.rtArrTime,
			);
		}

		const hasRT =
			run.wasTracked ||
			stops.some((s) => s.rtDepTime != null || s.rtArrTime != null);

		const category = run.category ?? "Other";
		const bg = CATEGORY_COLORS[category] ?? CATEGORY_COLORS.Other;

		vehicles.push({
			id: run.journeyRef,
			name: run.line,
			lat: pos.lat,
			lon: pos.lon,
			direction: run.destName,
			heading: pos.heading,
			category,
			operator: run.operator ?? "",
			bg,
			delay,
			occupancy: null,
			hasRT,
			hasGps: false,
			gpsFixAt: null,
			gpsPath: null,
			stationary: pos.stationary,
			externalTrackingUrl: null,
			serviceDate: run.dayOfOperation,
			waypoints: [],
			fetchedAt,
		});
	}

	return vehicles;
}

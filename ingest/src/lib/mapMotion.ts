import type { MapVehicle } from "./liveMap.ts";

export type LatLon = [number, number];

export interface MotionStop {
	lat: number | null;
	lon: number | null;
	arr: string | null;
	dep: string | null;
	/** Seconds since midnight (scheduled/rt coalesced, matches the server payload). */
	depSec: number | null;
	arrSec: number | null;
	/** Index of the nearest polyline point for this stop. */
	polyIdx: number | null;
}

export interface VehicleState {
	id: string;
	cat: string | null;
	isGhost: boolean;
	delayMin: number;
	hasGps: boolean;
	gpsLat: number | null;
	gpsLon: number | null;
	gpsReportedSec: number | null;
	gpsPolyIdx: number | null;
	prevGpsReportedSec: number | null;
	prevGpsPolyIdx: number | null;
	polyline: LatLon[] | null;
	stops: MotionStop[];
	_segIdx: number | null;
	_stale: boolean;
}

export function timeToSeconds(hms: string | null | undefined): number | null {
	if (!hms) return null;
	const m = /^(\d{2}):(\d{2}):(\d{2})/.exec(hms);
	if (!m) return null;
	return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

export function secondsNow(): number {
	const d = new Date();
	return (
		d.getHours() * 3600 +
		d.getMinutes() * 60 +
		d.getSeconds() +
		d.getMilliseconds() / 1000
	);
}

function distSq(a: LatLon, b: LatLon): number {
	const dx = a[0] - b[0];
	const dy = a[1] - b[1];
	return dx * dx + dy * dy;
}

export function nearestPolylineIndex(
	poly: LatLon[],
	lat: number,
	lon: number,
): number {
	let best = 0;
	let bestD = Number.POSITIVE_INFINITY;
	for (let i = 0; i < poly.length; i++) {
		const d = distSq(poly[i], [lat, lon]);
		if (d < bestD) {
			bestD = d;
			best = i;
		}
	}
	return best;
}

export function interpolateAlongPolyline(
	poly: LatLon[],
	startIdx: number,
	endIdx: number,
	progress: number,
): LatLon {
	if (endIdx <= startIdx) return poly[Math.min(startIdx, poly.length - 1)];
	const target = startIdx + (endIdx - startIdx) * progress;
	const i = Math.min(Math.floor(target), poly.length - 2);
	const frac = target - i;
	return [
		poly[i][0] + (poly[i + 1][0] - poly[i][0]) * frac,
		poly[i][1] + (poly[i + 1][1] - poly[i][1]) * frac,
	];
}

export interface Segment {
	from: MotionStop;
	to: MotionStop;
	progress: number;
}

export function findCurrentSegment(
	stops: MotionStop[],
	nowSec: number,
	state: VehicleState,
): Segment | null {
	// Fast path: last segment still contains now.
	const cached = state._segIdx;
	if (cached != null && cached < stops.length - 1) {
		const dep = stops[cached].depSec;
		const arr = stops[cached + 1].arrSec;
		if (
			dep !== null &&
			arr !== null &&
			arr > dep &&
			nowSec >= dep &&
			nowSec <= arr
		) {
			return {
				from: stops[cached],
				to: stops[cached + 1],
				progress: (nowSec - dep) / (arr - dep),
			};
		}
	}
	for (let i = 0; i < stops.length - 1; i++) {
		const dep = stops[i].depSec;
		const arr = stops[i + 1].arrSec;
		if (
			dep !== null &&
			arr !== null &&
			arr > dep &&
			nowSec >= dep &&
			nowSec <= arr
		) {
			state._segIdx = i;
			return {
				from: stops[i],
				to: stops[i + 1],
				progress: (nowSec - dep) / (arr - dep),
			};
		}
	}
	// Fell past all segment bounds — pin to the latest departed stop.
	for (let i = stops.length - 2; i >= 0; i--) {
		const dep = stops[i].depSec;
		if (dep !== null && nowSec >= dep) {
			state._segIdx = i;
			const arr = stops[i + 1].arrSec ?? dep + 60;
			return {
				from: stops[i],
				to: stops[i + 1],
				progress: Math.min(1, (nowSec - dep) / (arr - dep)),
			};
		}
	}
	return null;
}

/**
 * Ease a marker toward the target using a dt-based exponential. At tau=150ms,
 * ~99% of the gap closes in ~700ms regardless of frame-rate. Frame-rate
 * independence matters: a fixed per-frame factor gives jerky easing on slow
 * devices and too-slow settling on fast ones.
 */
export function easeMarkerTo(
	getCurrent: () => LatLon,
	setNext: (next: LatLon) => void,
	target: LatLon,
	dtMs: number,
): void {
	const [lat, lon] = getCurrent();
	const dLat = target[0] - lat;
	const dLon = target[1] - lon;
	if (Math.abs(dLat) < 1e-6 && Math.abs(dLon) < 1e-6) return;
	const tauMs = 150;
	const factor = 1 - Math.exp(-Math.max(0, dtMs) / tauMs);
	setNext([lat + dLat * factor, lon + dLon * factor]);
}

// How long a single prev/current GPS pair remains usable for deriving
// observed velocity. Beyond this the derived idxPerSec is too stale to
// trust — fall back to schedule-paced interp.
const MAX_PREV_AGE_SEC = 180;

// Hard cap on extrapolation duration. When a fix hasn't refreshed for a
// while (RMV hiccup, vehicle at a station with no data, etc), the marker
// should hold position rather than slide forever into a phantom location.
const MAX_EXTRAPOLATION_SEC = 120;

// Realistic per-second polyline-index rate. Jittery GPS snaps can produce
// huge spikes (e.g., momentary wrong-side snapping on a U-turn). Cap the
// extrapolation velocity so those spikes don't launch the marker ahead.
const MAX_IDX_PER_SEC = 2;

/**
 * Initialize or refresh per-vehicle motion state from a server payload entry.
 * Rotates previous GPS into `prev*` when the reportedAt timestamp advances,
 * giving us two points to derive observed velocity along the polyline.
 */
export function upsertVehicleState(
	prev: VehicleState | undefined,
	v: MapVehicle,
): VehicleState {
	const polyline: LatLon[] | null = (() => {
		if (!v.polyline) return null;
		try {
			const pts = JSON.parse(v.polyline) as LatLon[];
			return Array.isArray(pts) && pts.length >= 2 ? pts : null;
		} catch {
			return null;
		}
	})();

	const rawStops = (() => {
		if (!v.stops) return [];
		try {
			return JSON.parse(v.stops) as {
				lat: number | null;
				lon: number | null;
				arr: string | null;
				dep: string | null;
			}[];
		} catch {
			return [];
		}
	})();

	const stops: MotionStop[] = rawStops.map((s) => ({
		...s,
		depSec: timeToSeconds(s.dep),
		arrSec: timeToSeconds(s.arr),
		polyIdx:
			polyline && s.lat !== null && s.lon !== null
				? nearestPolylineIndex(polyline, s.lat, s.lon)
				: null,
	}));

	const hasGps = v.ghost !== 1 && v.lat !== null && v.lon !== null;
	const gpsReportedSec = v.reportedAt
		? (() => {
				const d = new Date(v.reportedAt);
				return Number.isNaN(d.getTime())
					? null
					: d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds();
			})()
		: null;
	const gpsPolyIdx =
		polyline && v.lat !== null && v.lon !== null
			? nearestPolylineIndex(polyline, v.lat, v.lon)
			: null;

	// Rotate prev/current when the GPS fix timestamp has advanced. Reject
	// the pair if the gap is too old to yield a usable velocity estimate.
	const gpsAdvanced =
		prev?.gpsReportedSec != null &&
		gpsReportedSec != null &&
		gpsReportedSec > prev.gpsReportedSec &&
		gpsReportedSec - prev.gpsReportedSec <= MAX_PREV_AGE_SEC;

	return {
		id: v.id,
		cat: v.category,
		isGhost: v.ghost === 1,
		delayMin: v.delayMin ?? 0,
		hasGps,
		gpsLat: hasGps ? v.lat : null,
		gpsLon: hasGps ? v.lon : null,
		gpsReportedSec,
		gpsPolyIdx,
		prevGpsReportedSec: gpsAdvanced ? (prev?.gpsReportedSec ?? null) : null,
		prevGpsPolyIdx: gpsAdvanced ? (prev?.gpsPolyIdx ?? null) : null,
		polyline,
		stops,
		_segIdx: prev?._segIdx ?? null,
		_stale: prev?._stale ?? false,
	};
}

/**
 * Compute the marker target for the current frame. Returns null when we don't
 * have enough data to place the marker (e.g. ghost with no passed stop yet).
 */
export function computeTarget(
	state: VehicleState,
	nowSec: number,
): LatLon | null {
	// Tracked: GPS anchor + observed-velocity or schedule-paced projection.
	if (state.hasGps && state.gpsLat !== null && state.gpsLon !== null) {
		const seg = findCurrentSegment(state.stops, nowSec, state);
		if (!seg || seg.to.arrSec === null) {
			return [state.gpsLat, state.gpsLon];
		}
		const gpsSec = state.gpsReportedSec ?? seg.from.depSec ?? 0;
		const baselineSec = Math.max(gpsSec, seg.from.depSec ?? 0);
		const arrSec = seg.to.arrSec;
		if (arrSec <= baselineSec) return [state.gpsLat, state.gpsLon];
		const frac = Math.max(
			0,
			Math.min(1, (nowSec - baselineSec) / (arrSec - baselineSec)),
		);

		// Observed-velocity extrapolation along the polyline.
		if (
			state.polyline &&
			state.polyline.length >= 2 &&
			state.gpsPolyIdx != null
		) {
			const targetIdx = seg.to.polyIdx ?? state.polyline.length - 1;
			let idxPerSec: number | null = null;
			if (
				state.prevGpsPolyIdx != null &&
				state.prevGpsReportedSec != null &&
				state.gpsReportedSec != null
			) {
				const dt = state.gpsReportedSec - state.prevGpsReportedSec;
				if (dt > 0) {
					idxPerSec = (state.gpsPolyIdx - state.prevGpsPolyIdx) / dt;
				}
			}
			if (idxPerSec !== null && idxPerSec >= 0) {
				// Cap both the derived velocity (noisy GPS can spike) and the
				// elapsed time we extrapolate over (stale fixes shouldn't fling
				// markers into phantom locations).
				const clampedIdxPerSec = Math.min(idxPerSec, MAX_IDX_PER_SEC);
				const rawElapsed = Math.max(
					0,
					nowSec - (state.gpsReportedSec ?? nowSec),
				);
				const elapsed = Math.min(rawElapsed, MAX_EXTRAPOLATION_SEC);
				const projIdx = Math.min(
					targetIdx,
					state.gpsPolyIdx + clampedIdxPerSec * elapsed,
				);
				if (projIdx > state.gpsPolyIdx) {
					const walkProgress =
						(projIdx - state.gpsPolyIdx) / (targetIdx - state.gpsPolyIdx);
					return interpolateAlongPolyline(
						state.polyline,
						state.gpsPolyIdx,
						targetIdx,
						walkProgress,
					);
				}
			}
			if (targetIdx > state.gpsPolyIdx) {
				return interpolateAlongPolyline(
					state.polyline,
					state.gpsPolyIdx,
					targetIdx,
					frac,
				);
			}
		}

		// No polyline — linear interp between GPS and next stop.
		if (seg.to.lat !== null && seg.to.lon !== null) {
			return [
				state.gpsLat + (seg.to.lat - state.gpsLat) * frac,
				state.gpsLon + (seg.to.lon - state.gpsLon) * frac,
			];
		}
		return [state.gpsLat, state.gpsLon];
	}

	// Ghost / no GPS: schedule-paced along the polyline if we have one,
	// else linear between schedule stops.
	const seg = findCurrentSegment(state.stops, nowSec, state);
	if (!seg) return null;
	if (state.polyline && state.polyline.length >= 2) {
		const startIdx = seg.from.polyIdx ?? 0;
		const endIdx = seg.to.polyIdx ?? 0;
		if (endIdx > startIdx) {
			return interpolateAlongPolyline(
				state.polyline,
				startIdx,
				endIdx,
				seg.progress,
			);
		}
	}
	if (
		seg.from.lat !== null &&
		seg.from.lon !== null &&
		seg.to.lat !== null &&
		seg.to.lon !== null
	) {
		return [
			seg.from.lat + (seg.to.lat - seg.from.lat) * seg.progress,
			seg.from.lon + (seg.to.lon - seg.from.lon) * seg.progress,
		];
	}
	return null;
}

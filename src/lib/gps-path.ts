/**
 * Shared helpers for the mid-poll motion animation of real-GPS
 * vehicles. Different sources (HEAG's `encodedPath`, bahn.expert's
 * `journey.polyline`) express forward motion differently; we
 * normalise them to a common `GpsPath` shape the client's animate
 * loop walks by elapsed-time percentage.
 *
 * Coordinate order throughout this module is `[lat, lon]`. GeoJSON
 * callers must flip their `[lon, lat]` pairs on the way in.
 */

export interface GpsPath {
	/** Ordered positions the vehicle is expected to move through,
	 * starting at the current GPS fix. 1-N points; a single-point path
	 * means "stationary" and the animation stops at that point. */
	points: [number, number][];
	/** How much wall-clock time the full path represents. Mid-poll
	 * animation walks along cumulative distance by
	 * `(now - fixAt) / windowMs`; once past 100 % the marker holds at
	 * the last point until the next poll supplies a fresh path. */
	windowMs: number;
}

const EARTH_M_PER_DEG = 111_000;

/** Quick equirectangular distance in metres. Accurate enough for the
 * short segments we work with (usually < 100 m each) and much cheaper
 * than a proper haversine for per-frame animation. */
export function distanceMeters(
	a: [number, number],
	b: [number, number],
): number {
	const dLat = (a[0] - b[0]) * EARTH_M_PER_DEG;
	const dLon =
		(a[1] - b[1]) * EARTH_M_PER_DEG * Math.cos((a[0] * Math.PI) / 180);
	return Math.sqrt(dLat * dLat + dLon * dLon);
}

/** Interpolate a position along `points` at `pct` percent of the
 * path's cumulative length. `pct` is clamped to [0, 100]; when the
 * path is degenerate (<2 points or zero total length) the returned
 * point is the first entry. */
export function locationAtPercent(
	points: [number, number][],
	pct: number,
): [number, number] {
	if (points.length === 0) return [0, 0];
	if (points.length === 1) return points[0];
	const clamped = Math.max(0, Math.min(100, pct));
	const segLengths: number[] = [];
	let total = 0;
	for (let i = 0; i < points.length - 1; i++) {
		const d = distanceMeters(points[i], points[i + 1]);
		segLengths.push(d);
		total += d;
	}
	if (total === 0) return points[0];
	const target = (total * clamped) / 100;
	let cum = 0;
	for (let i = 0; i < segLengths.length; i++) {
		const next = cum + segLengths[i];
		if (next >= target) {
			const ratio = segLengths[i] === 0 ? 0 : (target - cum) / segLengths[i];
			const [lat0, lon0] = points[i];
			const [lat1, lon1] = points[i + 1];
			return [lat0 + ratio * (lat1 - lat0), lon0 + ratio * (lon1 - lon0)];
		}
		cum = next;
	}
	return points[points.length - 1];
}

/** Standard Google-algorithm polyline decoder with lat-before-lon
 * order — HEAG's `encodedPath` uses this format. Returns
 * `[lat, lon]` pairs. */
export function decodeGooglePolyline(str: string): [number, number][] {
	if (!str) return [];
	const factor = 10 ** 5;
	let lat = 0;
	let lon = 0;
	const out: [number, number][] = [];
	let i = 0;
	while (i < str.length) {
		let b: number;
		let shift = 0;
		let result = 0;
		do {
			b = str.charCodeAt(i++) - 63;
			result |= (b & 0x1f) << shift;
			shift += 5;
		} while (b >= 0x20);
		const dLat = result & 1 ? ~(result >> 1) : result >> 1;
		lat += dLat;
		shift = 0;
		result = 0;
		do {
			b = str.charCodeAt(i++) - 63;
			result |= (b & 0x1f) << shift;
			shift += 5;
		} while (b >= 0x20);
		const dLon = result & 1 ? ~(result >> 1) : result >> 1;
		lon += dLon;
		out.push([lat / factor, lon / factor]);
	}
	return out;
}

/** Find the polyline vertex nearest to `target`. Linear scan — fine
 * for the ~1-3 k point journeys DB publishes; if we ever care we can
 * add a spatial index. Returns -1 when the polyline is empty. */
export function closestPointIndex(
	polyline: [number, number][],
	target: [number, number],
): number {
	if (polyline.length === 0) return -1;
	let best = 0;
	let bestDist = distanceMeters(polyline[0], target);
	for (let i = 1; i < polyline.length; i++) {
		const d = distanceMeters(polyline[i], target);
		if (d < bestDist) {
			best = i;
			bestDist = d;
		}
	}
	return best;
}

/** Slice a polyline from `fromIdx` forward until the cumulative
 * distance covers at least `meters`, or until the polyline ends. The
 * anchor point is prepended so the slice starts exactly at `anchor`
 * (which may sit between two polyline vertices). */
export function sliceForward(
	polyline: [number, number][],
	fromIdx: number,
	anchor: [number, number],
	meters: number,
): [number, number][] {
	if (polyline.length === 0) return [anchor];
	if (meters <= 0 || fromIdx < 0 || fromIdx >= polyline.length) return [anchor];
	const out: [number, number][] = [anchor];
	let remaining = meters;
	let i = fromIdx;
	let prev = anchor;
	while (i < polyline.length && remaining > 0) {
		const next = polyline[i];
		const d = distanceMeters(prev, next);
		out.push(next);
		remaining -= d;
		prev = next;
		i++;
	}
	return out;
}

/** Sanity cap so a runaway polyline slice doesn't blow up the payload
 * we send to the client. Roughly 30 s at 300 km/h (= 2.5 km) worth of
 * points at DB's typical ~20 m spacing. */
export const MAX_GPS_PATH_POINTS = 150;

/** Ensure the slice stays below `MAX_GPS_PATH_POINTS` by down-sampling
 * evenly. Preserves the start and end so `locationAtPercent` still
 * lands at the correct endpoints. */
export function downsample(
	points: [number, number][],
	max: number = MAX_GPS_PATH_POINTS,
): [number, number][] {
	if (points.length <= max) return points;
	const step = (points.length - 1) / (max - 1);
	const out: [number, number][] = [];
	for (let i = 0; i < max; i++) {
		const idx = Math.round(i * step);
		out.push(points[idx]);
	}
	return out;
}

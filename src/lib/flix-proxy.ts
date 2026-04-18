import {
	FLIX_TRACKING_URL_BASE,
	type FlixCall,
	type FlixRide,
	type FlixTimetableEntry,
	flixRide,
	flixRideRoute,
	flixTimetable,
} from "./flix.ts";
import { FLIX_STATIONS } from "./flix-stations.ts";
import { decodeEncodedPolyline } from "./mgate.ts";

interface Waypoint {
	lat: number;
	lon: number;
	t: number;
	heading: number;
}

export interface FlixVehicle {
	id: string;
	name: string;
	lat: number;
	lon: number;
	direction: string;
	heading: number;
	category: "Flixtrain" | "Flixbus";
	operator: string;
	bg: string;
	delay: number | null;
	occupancy: null;
	hasRT: true;
	/** Flix rides come from the operator's live `location` feed — always
	 * a real GPS report, never interpolated. Surfaced by the map's "Live
	 * positions" layer to match the HAFAS `aPos` signal. */
	hasGps: true;
	/** Unix-ms timestamp of the last live-feed position update, taken from
	 * `ride.location.updated_at`. Shown in the popup alongside the GPS
	 * indicator. */
	gpsFixAt: number;
	stationary: boolean;
	externalTrackingUrl: string;
	serviceDate: null;
	waypoints: Waypoint[];
	fetchedAt: number;
}

const CATEGORY_BG: Record<"Flixtrain" | "Flixbus", string> = {
	Flixtrain: "#73D700",
	Flixbus: "#44A12C",
};

/** Regional carriers surfaced by Flix at shared stations. RMV already
 * exposes these through `JourneyGeoPos`; drop to avoid duplicate icons. */
const EXCLUDED_BRANDS = new Set([
	"DB Regio",
	"HLB Hessenbahn",
	"VIAS",
	"VIAS ",
]);

const MAX_ACTIVE = 200;
const DROP_AFTER_LAST_STOP_MS = 15 * 60 * 1000;
const HEADING_MIN_METERS = 20;
/** Forward-projection horizon in seconds. One fix ahead (~30 s) matches
 * the upstream position cadence so the marker is always gliding toward a
 * point the next real fix will either confirm or correct. */
const PROJECT_SEC = 30;
/** Number of forward frames to emit across PROJECT_SEC. Matches RMV's
 * ~5 s cadence (8 frames / 35 s) so `interpolateVehicle` has short
 * segments and the marker tracks curves without cutting corners. */
const PROJECT_FRAMES = 6;

interface PrevPos {
	lat: number;
	lon: number;
	t: number;
	heading: number;
}

const lastPositions = new Map<string, PrevPos>();
/** Decoded route polyline per ride UUID. Populated lazily on first request
 * by `/api/flix/route/:uuid`, or eagerly (fire-and-forget) during the
 * aggregation pass so between-fix motion can follow the actual track. */
const polyCache = new Map<string, [number, number][]>();

interface MemoEntry {
	body: string;
	expires: number;
}

const memo = new Map<string, MemoEntry>();

/** Generic TTL memo: returns cached JSON string when fresh; otherwise runs
 * `build`, JSON-encodes the result, stores, and returns. Errors from
 * `build` are not cached — they bubble up to the handler. */
export async function memoGet(
	key: string,
	ttlSec: number,
	build: () => Promise<unknown>,
): Promise<string> {
	const now = Date.now();
	const hit = memo.get(key);
	if (hit && hit.expires > now) return hit.body;
	const value = await build();
	const body = JSON.stringify(value);
	memo.set(key, { body, expires: now + ttlSec * 1000 });
	return body;
}

function haversine(
	a: { lat: number; lon: number },
	b: { lat: number; lon: number },
): number {
	const toRad = (d: number) => (d * Math.PI) / 180;
	const R = 6371000;
	const dLat = toRad(b.lat - a.lat);
	const dLon = toRad(b.lon - a.lon);
	const la1 = toRad(a.lat);
	const la2 = toRad(b.lat);
	const x =
		Math.sin(dLat / 2) ** 2 +
		Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
	return 2 * R * Math.asin(Math.sqrt(x));
}

export function bearingDeg(
	a: { lat: number; lon: number },
	b: { lat: number; lon: number },
): number {
	const toRad = (d: number) => (d * Math.PI) / 180;
	const toDeg = (r: number) => (r * 180) / Math.PI;
	const la1 = toRad(a.lat);
	const la2 = toRad(b.lat);
	const dLon = toRad(b.lon - a.lon);
	const y = Math.sin(dLon) * Math.cos(la2);
	const x =
		Math.cos(la1) * Math.sin(la2) -
		Math.sin(la1) * Math.cos(la2) * Math.cos(dLon);
	return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

/** Convert compass bearing (0°–360°) into RMV-style dirGeo units (0–31,
 * 11.25° per step). Matches the icon rotation at map/index.tsx:414. */
export function toDirGeo(bearing: number): number {
	return Math.round(bearing / 11.25) % 32;
}

function pickCategory(
	entry: FlixTimetableEntry | FlixRide,
): "Flixtrain" | "Flixbus" | null {
	const m = entry.line?.means_of_transport;
	const bn = entry.line?.brand?.name ?? null;
	if (bn && EXCLUDED_BRANDS.has(bn)) return null;
	if (m === "TRAIN") return "Flixtrain";
	if (m === "BUS") return "Flixbus";
	return null;
}

function lastCallEndMs(calls: FlixCall[]): number | null {
	if (!calls || calls.length === 0) return null;
	const last = calls[calls.length - 1];
	const ts = last.arrival?.scheduled ?? last.departure?.scheduled;
	return ts ? new Date(ts).getTime() : null;
}

function rideDelayMinutes(ride: FlixRide): number | null {
	const sd = ride.status?.deviation?.deviation_seconds;
	if (typeof sd === "number") return Math.round(sd / 60);
	const now = Date.now();
	for (const c of ride.calls ?? []) {
		const dev = c.departure?.deviation ?? c.arrival?.deviation;
		const ts = c.departure?.scheduled ?? c.arrival?.scheduled;
		if (dev && ts && new Date(ts).getTime() >= now)
			return Math.round(dev.deviation_seconds / 60);
	}
	return null;
}

export async function getAggregatedVehicles(): Promise<{
	vehicles: FlixVehicle[];
	serverTime: number;
}> {
	const now = Date.now();
	const from = new Date(now).toISOString();
	const to = new Date(now + 6 * 60 * 60 * 1000).toISOString();

	const ttPromises = FLIX_STATIONS.flatMap((s) => [
		flixTimetable(s.uuid, "departures", { from, to }).catch(() => null),
		flixTimetable(s.uuid, "arrivals", { from, to }).catch(() => null),
	]);
	const ttResults = await Promise.all(ttPromises);

	const rideIds = new Set<string>();
	for (const r of ttResults) {
		if (!r) continue;
		for (const ride of r.rides ?? []) {
			if (pickCategory(ride) == null) continue;
			const lastMs = lastCallEndMs(ride.calls ?? []);
			if (lastMs != null && now > lastMs + DROP_AFTER_LAST_STOP_MS) continue;
			rideIds.add(ride.id);
			if (rideIds.size >= MAX_ACTIVE) break;
		}
		if (rideIds.size >= MAX_ACTIVE) break;
	}

	const rides = await Promise.all(
		Array.from(rideIds).map((id) => flixRide(id).catch(() => null)),
	);

	const vehicles: FlixVehicle[] = [];
	const seen = new Set<string>();

	for (const ride of rides) {
		if (!ride) continue;
		const cat = pickCategory(ride);
		if (!cat) continue;
		if (!ride.location?.coordinates) continue;

		const lat = ride.location.coordinates.latitude;
		const lon = ride.location.coordinates.longitude;
		const curT = new Date(ride.location.updated_at).getTime();

		const prev = lastPositions.get(ride.id);
		let heading = prev?.heading ?? 0;
		const movedMeters = prev ? haversine(prev, { lat, lon }) : 0;
		if (prev && movedMeters > HEADING_MIN_METERS) {
			heading = toDirGeo(bearingDeg(prev, { lat, lon }));
		}

		// Flix's `speed_category: STATIONARY` lags behind actual motion —
		// an upstream-stale flag can persist for minutes while the bus
		// races down the autobahn. Only treat as truly stationary when
		// both Flix says so AND our own fix-to-fix haversine confirms it.
		const flixSaysStationary = ride.location.speed_category === "STATIONARY";
		const trulyStationary = flixSaysStationary && (!prev || movedMeters < 20);

		const waypoints: Waypoint[] = [];
		const canProject = prev && prev.t < curT && !trulyStationary;
		if (prev && prev.t < curT) {
			waypoints.push({
				lat: prev.lat,
				lon: prev.lon,
				t: prev.t,
				heading,
			});
		}
		waypoints.push({ lat, lon, t: curT, heading });
		if (canProject) {
			const poly = polyCache.get(ride.id);
			const polyPts = poly
				? buildPolyWaypoints(poly, prev, { lat, lon }, curT)
				: null;
			if (polyPts && polyPts.length > 0) {
				waypoints.push(...polyPts);
			} else {
				// Fallback: emit dense linear-extrapolated frames using
				// the prev→cur velocity vector when the polyline isn't
				// cached or the vehicle is off-route. Frame cadence
				// matches the polyline-follow path so animation density
				// is uniform across both modes.
				const dt = (curT - prev.t) / 1000;
				if (dt > 0) {
					const vLat = (lat - prev.lat) / dt;
					const vLon = (lon - prev.lon) / dt;
					for (let f = 1; f <= PROJECT_FRAMES; f++) {
						const sec = (f * PROJECT_SEC) / PROJECT_FRAMES;
						waypoints.push({
							lat: lat + vLat * sec,
							lon: lon + vLon * sec,
							t: curT + sec * 1000,
							heading,
						});
					}
				}
			}
			// Kick off polyline fetch in background for next call when
			// we don't have one cached yet.
			if (!poly && !polyCache.has(ride.id)) {
				fetchAndCachePolyline(ride.id).catch(() => {});
			}
		}

		lastPositions.set(ride.id, { lat, lon, t: curT, heading });
		seen.add(ride.id);

		const name = ride.line.code.replace(/[[\]]/g, "").trim() || "?";
		const operator = ride.line.brand?.name?.trim() || "Unknown";

		vehicles.push({
			id: ride.id,
			name,
			lat,
			lon,
			direction: ride.line.direction ?? "",
			heading,
			category: cat,
			operator,
			bg: CATEGORY_BG[cat],
			delay: rideDelayMinutes(ride),
			occupancy: null,
			hasRT: true,
			hasGps: true,
			gpsFixAt: curT,
			stationary: trulyStationary,
			externalTrackingUrl: FLIX_TRACKING_URL_BASE + ride.id,
			serviceDate: null,
			waypoints,
			fetchedAt: now,
		});
	}

	for (const id of lastPositions.keys()) {
		if (!seen.has(id)) {
			lastPositions.delete(id);
			polyCache.delete(id);
		}
	}

	return { vehicles, serverTime: now };
}

async function fetchAndCachePolyline(
	rideUuid: string,
): Promise<[number, number][] | null> {
	const cached = polyCache.get(rideUuid);
	if (cached) return cached;
	const r = await flixRideRoute(rideUuid);
	const segs = [...(r.segments ?? [])].sort(
		(a, b) => a.segment_sequence - b.segment_sequence,
	);
	if (segs.length === 0) return null;
	const out: [number, number][] = [];
	for (const seg of segs) {
		const pts = decodeEncodedPolyline(seg.polyline);
		if (
			out.length > 0 &&
			pts.length > 0 &&
			out[out.length - 1][0] === pts[0][0] &&
			out[out.length - 1][1] === pts[0][1]
		) {
			out.push(...pts.slice(1));
		} else {
			out.push(...pts);
		}
	}
	if (out.length === 0) return null;
	polyCache.set(rideUuid, out);
	return out;
}

export async function getRoutePolyline(
	rideUuid: string,
): Promise<[number, number][] | null> {
	return fetchAndCachePolyline(rideUuid);
}

/** Walk forward along the cached polyline from the vehicle's current GPS
 * fix, emitting one waypoint per traversed polyline vertex (timestamped
 * by cumulative distance / speed) up to PROJECT_SEC. Heading is the
 * bearing of each emitted segment so the marker rotates through curves.
 * Returns null when projection isn't possible (no velocity, GPS too far
 * from track, off-route vehicle). */
function buildPolyWaypoints(
	poly: [number, number][],
	prev: PrevPos,
	cur: { lat: number; lon: number },
	curT: number,
): Waypoint[] | null {
	const dtSec = (curT - prev.t) / 1000;
	if (dtSec <= 0) return null;
	const dMeters = haversine(prev, cur);
	const metersPerSec = dMeters / dtSec;
	if (metersPerSec < 1) return null;

	let bestIdx = 0;
	let bestD = Number.POSITIVE_INFINITY;
	for (let i = 0; i < poly.length; i++) {
		const dLat = poly[i][0] - cur.lat;
		const dLon = poly[i][1] - cur.lon;
		const d = dLat * dLat + dLon * dLon;
		if (d < bestD) {
			bestD = d;
			bestIdx = i;
		}
	}

	// Sanity: if the nearest polyline vertex is >500 m away, the vehicle
	// is off-route — fall back to linear projection instead of snapping
	// it to the track.
	const nearestMeters = haversine(
		{ lat: poly[bestIdx][0], lon: poly[bestIdx][1] },
		cur,
	);
	if (nearestMeters > 500) return null;

	const rideLat = cur.lat - prev.lat;
	const rideLon = cur.lon - prev.lon;
	const dot = (fromIdx: number, toIdx: number) => {
		const dLat = poly[toIdx][0] - poly[fromIdx][0];
		const dLon = poly[toIdx][1] - poly[fromIdx][1];
		return dLat * rideLat + dLon * rideLon;
	};
	const fwdIdx = bestIdx + 1 < poly.length ? bestIdx + 1 : null;
	const bwdIdx = bestIdx - 1 >= 0 ? bestIdx - 1 : null;
	const dotFwd =
		fwdIdx !== null ? dot(bestIdx, fwdIdx) : Number.NEGATIVE_INFINITY;
	const dotBwd =
		bwdIdx !== null ? dot(bestIdx, bwdIdx) : Number.NEGATIVE_INFINITY;
	const dir: 1 | -1 = dotFwd >= dotBwd ? 1 : -1;

	// Emit frames at fixed time intervals so the client's linear
	// interpolator follows the polyline tightly — matches RMV's ~5 s
	// cadence (8 frames across 35 s). Sparse vertex-only emission
	// produced noticeable cut-corners on highway-length segments.
	const waypoints: Waypoint[] = [];
	let consumed = 0;
	let fromLat = cur.lat;
	let fromLon = cur.lon;
	let fromHeading = prev.heading;
	let idx = bestIdx;

	for (let frame = 1; frame <= PROJECT_FRAMES; frame++) {
		const targetSec = (frame * PROJECT_SEC) / PROJECT_FRAMES;
		const targetMeters = metersPerSec * targetSec;
		// Walk forward along polyline until cumulative distance reaches
		// targetMeters, interpolating within the final segment.
		let placed = false;
		// Cap vertex steps per frame to bound worst-case CPU.
		for (let step = 0; step < 128; step++) {
			const nextIdx = idx + dir;
			if (nextIdx < 0 || nextIdx >= poly.length) break;
			const nextLat = poly[nextIdx][0];
			const nextLon = poly[nextIdx][1];
			const seg = haversine(
				{ lat: fromLat, lon: fromLon },
				{ lat: nextLat, lon: nextLon },
			);
			const heading = toDirGeo(
				bearingDeg(
					{ lat: fromLat, lon: fromLon },
					{ lat: nextLat, lon: nextLon },
				),
			);
			const remaining = targetMeters - consumed;
			if (seg >= remaining) {
				const ratio = seg > 0 ? remaining / seg : 0;
				waypoints.push({
					lat: fromLat + ratio * (nextLat - fromLat),
					lon: fromLon + ratio * (nextLon - fromLon),
					t: curT + targetSec * 1000,
					heading,
				});
				// Advance `from` to the emitted point and keep same
				// vertex idx so subsequent frames walk from here.
				fromLat += ratio * (nextLat - fromLat);
				fromLon += ratio * (nextLon - fromLon);
				consumed += ratio * seg;
				fromHeading = heading;
				placed = true;
				break;
			}
			consumed += seg;
			fromLat = nextLat;
			fromLon = nextLon;
			fromHeading = heading;
			idx = nextIdx;
		}
		if (!placed) {
			// Ran out of polyline before hitting target distance — pin
			// the remaining frames at the last vertex so animation ends
			// there rather than snapping back.
			waypoints.push({
				lat: fromLat,
				lon: fromLon,
				t: curT + targetSec * 1000,
				heading: fromHeading,
			});
		}
	}

	return waypoints.length > 0 ? waypoints : null;
}

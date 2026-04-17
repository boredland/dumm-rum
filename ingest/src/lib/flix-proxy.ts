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
	externalTrackingUrl: string;
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

interface PrevPos {
	lat: number;
	lon: number;
	t: number;
	heading: number;
}

const lastPositions = new Map<string, PrevPos>();

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

function bearingDeg(
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
function toDirGeo(bearing: number): number {
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
		if (prev) {
			const meters = haversine(prev, { lat, lon });
			if (meters > HEADING_MIN_METERS) {
				heading = toDirGeo(bearingDeg(prev, { lat, lon }));
			}
		}

		const waypoints: Waypoint[] =
			prev && prev.t < curT
				? [
						{ lat: prev.lat, lon: prev.lon, t: prev.t, heading },
						{ lat, lon, t: curT, heading },
					]
				: [{ lat, lon, t: curT, heading }];

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
			externalTrackingUrl: FLIX_TRACKING_URL_BASE + ride.id,
			waypoints,
			fetchedAt: now,
		});
	}

	for (const id of lastPositions.keys()) {
		if (!seen.has(id)) lastPositions.delete(id);
	}

	return { vehicles, serverTime: now };
}

export async function getRoutePolyline(
	rideUuid: string,
): Promise<[number, number][] | null> {
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
	return out.length > 0 ? out : null;
}

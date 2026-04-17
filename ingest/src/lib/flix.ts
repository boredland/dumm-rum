/**
 * Flix API HTTP client. The API key is public — it's hardcoded in the
 * `flixtrain.com/track` SPA bundle — so proxying is about CORS, caching,
 * and server-side aggregation, not secret-hiding.
 *
 * Endpoint survey based on `flixtrain.com/track` app bundle (wimbApi chunk):
 *  - `/gis/v2/timetable/{sid}/{arrDep}` — rides at a station in a window
 *  - `/gis/v3/ride/{uuid}` — single ride incl. live `location` + deviation
 *  - `/gis/v3/ride/{uuid}/route` — encoded polyline, split into per-stop segments
 *  - `/search/autocomplete/stations` — resolve station UUIDs
 */

export const FLIX_API_BASE = "https://global.api.flixbus.com";
export const FLIX_API_KEY = "7781b8fa-07cf-4ab7-8b62-1f3178523ba0";
export const FLIX_TRACKING_URL_BASE = "https://global.flixbus.com/track/ride/";

export interface FlixLocation {
	coordinates: { latitude: number; longitude: number };
	updated_at: string;
	speed_category: "STATIONARY" | "SLOW" | "MODERATE" | "FAST" | string;
}

export interface FlixBrand {
	id: string;
	name: string | null;
}

export interface FlixLine {
	code: string;
	direction: string;
	name: string;
	trip_number: number;
	means_of_transport: "TRAIN" | "BUS" | string;
	brand: FlixBrand | null;
}

export interface FlixDeviation {
	deviation_timestamp: string;
	deviation_seconds: number;
	reason: { code?: string } | null;
	deviation_class: "ON_TIME" | "LATE" | "EARLY" | string;
	deviation_type: "ACTUAL" | "ESTIMATED" | string;
	updated_at: string;
}

export interface FlixStopTime {
	scheduled: string | null;
	deviation: FlixDeviation | null;
	platform: { planned: string | null; actual: string | null } | null;
}

export interface FlixStop {
	id: string;
	type: "TRAIN" | "BUS" | string;
	timezone: string;
	name: string;
	description: string;
	city: { id: string; name: string };
	code: string;
	location: { latitude: number; longitude: number };
}

export interface FlixCall {
	sequence: number;
	stop: FlixStop;
	arrival: FlixStopTime | null;
	departure: FlixStopTime | null;
}

export interface FlixRide {
	id: string;
	line: FlixLine;
	location: FlixLocation | null;
	status: {
		segment: number | null;
		next_stop_sequence: number | null;
		has_arrived_at_next_stop: boolean | null;
		progress: string | null;
		deviation: FlixDeviation | null;
		scheduled_timestamp: string | null;
	};
	platform: { planned: string | null; actual: string | null } | null;
	vehicle: unknown;
	calls: FlixCall[];
}

export interface FlixTimetableEntry {
	id: string;
	status: FlixRide["status"];
	platform: FlixRide["platform"];
	line: FlixLine;
	location: FlixLocation | null;
	calls: FlixCall[];
}

export interface FlixTimetableResponse {
	station: { name: string; timezone: string; uuid: string | null };
	rides: FlixTimetableEntry[];
}

export interface FlixRouteSegment {
	segment_sequence: number;
	from_stop_uuid: string;
	to_stop_uuid: string;
	polyline: string;
}

export interface FlixRouteResponse {
	ride_uuid: string;
	segments: FlixRouteSegment[];
}

export interface FlixAutocompleteStation {
	id: string | null;
	name: string;
	is_train: boolean | null;
	city: { name: string; slug: string };
	location: { lat: number; lon: number };
}

function qs(params: Record<string, string>): string {
	return new URLSearchParams(params).toString();
}

async function getJson<T>(url: string, lang?: string): Promise<T> {
	const headers: Record<string, string> = lang
		? { "Accept-Language": lang }
		: {};
	const resp = await fetch(url, { headers });
	if (!resp.ok) {
		throw new Error(`Flix ${resp.status}: ${url}`);
	}
	return (await resp.json()) as T;
}

export async function flixAutocompleteStations(
	q: string,
	country = "de",
	lang = "de",
	limit = 20,
): Promise<FlixAutocompleteStation[]> {
	const url = `${FLIX_API_BASE}/search/autocomplete/stations?${qs({
		q,
		lang,
		country,
		limit: String(limit),
	})}`;
	return getJson<FlixAutocompleteStation[]>(url);
}

export async function flixTimetable(
	stationUuid: string,
	arrDep: "departures" | "arrivals",
	opts: { from: string; to: string; lang?: string },
): Promise<FlixTimetableResponse> {
	const url = `${FLIX_API_BASE}/gis/v2/timetable/${stationUuid}/${arrDep}?${qs({
		from: opts.from,
		to: opts.to,
		apiKey: FLIX_API_KEY,
	})}`;
	return getJson<FlixTimetableResponse>(url, opts.lang);
}

export async function flixRide(
	rideUuid: string,
	lang = "de",
): Promise<FlixRide> {
	const url = `${FLIX_API_BASE}/gis/v3/ride/${rideUuid}?${qs({
		apiKey: FLIX_API_KEY,
	})}`;
	return getJson<FlixRide>(url, lang);
}

export async function flixRideRoute(
	rideUuid: string,
): Promise<FlixRouteResponse> {
	const url = `${FLIX_API_BASE}/gis/v3/ride/${rideUuid}/route?${qs({
		apiKey: FLIX_API_KEY,
	})}`;
	return getJson<FlixRouteResponse>(url);
}

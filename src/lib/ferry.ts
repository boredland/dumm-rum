/**
 * Primus-Linie ferry schedule + OSM-derived Main-river polyline. No live
 * GPS for these ferries — positions are interpolated from the published
 * timetable along the real river track (OSM relation 19587338).
 */

import dayjs from "dayjs";
import timezone from "dayjs/plugin/timezone.js";
import utc from "dayjs/plugin/utc.js";
import { bearingDeg, toDirGeo } from "./flix-proxy.ts";

dayjs.extend(utc);
dayjs.extend(timezone);

interface Waypoint {
	lat: number;
	lon: number;
	t: number;
	heading: number;
}

export interface FerryVehicle {
	id: string;
	name: string;
	lat: number;
	lon: number;
	direction: string;
	heading: number;
	category: "Ferry";
	operator: string;
	bg: string;
	delay: null;
	occupancy: null;
	hasRT: false;
	/** Ferry positions are schedule-interpolated along the OSM river track,
	 * never real GPS. Mirrors the HAFAS/Flix `hasGps` flag so the map's
	 * GPS indicator dot is (correctly) absent on these markers. */
	hasGps: false;
	/** No GPS source, so no fix timestamp — typed as null to line up with
	 * the RMV `Vehicle` shape for the shared popup renderer. */
	gpsFixAt: null;
	stationary: false;
	externalTrackingUrl: string | null;
	serviceDate: null;
	waypoints: Waypoint[];
	fetchedAt: number;
}

/** OSM relation 19587338, ways stitched Frankfurt → Aschaffenburg. Each
 * pair is [lat, lon]. 305 points spanning ~55 km of the Main. */
const PRIMUS_LINIE_POLYLINE: [number, number][] = [
	[50.108206, 8.682442],
	[50.108308, 8.682962],
	[50.108542, 8.684432],
	[50.108685, 8.685922],
	[50.108675, 8.687734],
	[50.108614, 8.688674],
	[50.10828, 8.690853],
	[50.108069, 8.692036],
	[50.107979, 8.692732],
	[50.107897, 8.693489],
	[50.107731, 8.694883],
	[50.10757, 8.696391],
	[50.107207, 8.699349],
	[50.106935, 8.701628],
	[50.106676, 8.704608],
	[50.106652, 8.705271],
	[50.106598, 8.708968],
	[50.106336, 8.714986],
	[50.106384, 8.716769],
	[50.106546, 8.718802],
	[50.10649, 8.719982],
	[50.106608, 8.721273],
	[50.10689, 8.723048],
	[50.107091, 8.724458],
	[50.107198, 8.724888],
	[50.108019, 8.727835],
	[50.108482, 8.729491],
	[50.108728, 8.730154],
	[50.109692, 8.733066],
	[50.11063, 8.734493],
	[50.11103, 8.735565],
	[50.111776, 8.737244],
	[50.113203, 8.739798],
	[50.115124, 8.74458],
	[50.115241, 8.745248],
	[50.115631, 8.747744],
	[50.115663, 8.750173],
	[50.115408, 8.752173],
	[50.115103, 8.753569],
	[50.114013, 8.756367],
	[50.112609, 8.758584],
	[50.111125, 8.76083],
	[50.109743, 8.7631],
	[50.108705, 8.766207],
	[50.108609, 8.766537],
	[50.108432, 8.767267],
	[50.108303, 8.767961],
	[50.108128, 8.769273],
	[50.108056, 8.770478],
	[50.108046, 8.771218],
	[50.108074, 8.772462],
	[50.108323, 8.774038],
	[50.109563, 8.777428],
	[50.110665, 8.779268],
	[50.111578, 8.78029],
	[50.112227, 8.780805],
	[50.112629, 8.780925],
	[50.113827, 8.781056],
	[50.114831, 8.780857],
	[50.116955, 8.780041],
	[50.118672, 8.778153],
	[50.120066, 8.776181],
	[50.120483, 8.775647],
	[50.124196, 8.771971],
	[50.125237, 8.770976],
	[50.125488, 8.770774],
	[50.1269, 8.769637],
	[50.127864, 8.769193],
	[50.129423, 8.768874],
	[50.1308, 8.768747],
	[50.131823, 8.769012],
	[50.133471, 8.769991],
	[50.134065, 8.770679],
	[50.134808, 8.771575],
	[50.136057, 8.774021],
	[50.137058, 8.777969],
	[50.137421, 8.781359],
	[50.13731, 8.785602],
	[50.137179, 8.787431],
	[50.136675, 8.789811],
	[50.135606, 8.794303],
	[50.134821, 8.797767],
	[50.134652, 8.798722],
	[50.134267, 8.800673],
	[50.13406, 8.802645],
	[50.133911, 8.813951],
	[50.133866, 8.814885],
	[50.133785, 8.816511],
	[50.133264, 8.819487],
	[50.133044, 8.820741],
	[50.131878, 8.826287],
	[50.131459, 8.828368],
	[50.130411, 8.833772],
	[50.129956, 8.836734],
	[50.129877, 8.837765],
	[50.129823, 8.839036],
	[50.129731, 8.840657],
	[50.129663, 8.841855],
	[50.129481, 8.843503],
	[50.128979, 8.846364],
	[50.127083, 8.854494],
	[50.126888, 8.855441],
	[50.126176, 8.858522],
	[50.125751, 8.860634],
	[50.125511, 8.862775],
	[50.125007, 8.869886],
	[50.12492, 8.871339],
	[50.124887, 8.87181],
	[50.124729, 8.874342],
	[50.124439, 8.879598],
	[50.124202, 8.885083],
	[50.12416, 8.886962],
	[50.124311, 8.888534],
	[50.12476, 8.890575],
	[50.125412, 8.892576],
	[50.126306, 8.89459],
	[50.127027, 8.896213],
	[50.127873, 8.898041],
	[50.128554, 8.899654],
	[50.128875, 8.900838],
	[50.12897, 8.901453],
	[50.128992, 8.902052],
	[50.128849, 8.90319],
	[50.128593, 8.904294],
	[50.127699, 8.906007],
	[50.12352, 8.911074],
	[50.123322, 8.911323],
	[50.122349, 8.912354],
	[50.121521, 8.913192],
	[50.120623, 8.91387],
	[50.118929, 8.914941],
	[50.115174, 8.916557],
	[50.112852, 8.91746],
	[50.110888, 8.918673],
	[50.110141, 8.919518],
	[50.109494, 8.920415],
	[50.108775, 8.921877],
	[50.108518, 8.922436],
	[50.108296, 8.922965],
	[50.108054, 8.923726],
	[50.107767, 8.924832],
	[50.107551, 8.926204],
	[50.107502, 8.926623],
	[50.107463, 8.930071],
	[50.107456, 8.931631],
	[50.107332, 8.93336],
	[50.107115, 8.934701],
	[50.106941, 8.935394],
	[50.106749, 8.936006],
	[50.10655, 8.936515],
	[50.10612, 8.937548],
	[50.10557, 8.938592],
	[50.105188, 8.939187],
	[50.104794, 8.939745],
	[50.104411, 8.94016],
	[50.103963, 8.940532],
	[50.103418, 8.940971],
	[50.102922, 8.941289],
	[50.102336, 8.941591],
	[50.101808, 8.941799],
	[50.10125, 8.941959],
	[50.100835, 8.942081],
	[50.100217, 8.94212],
	[50.097636, 8.942307],
	[50.094038, 8.942752],
	[50.088601, 8.943413],
	[50.088174, 8.943397],
	[50.086326, 8.943332],
	[50.086218, 8.943343],
	[50.085932, 8.943361],
	[50.08481, 8.943475],
	[50.083457, 8.94379],
	[50.08223, 8.94449],
	[50.080947, 8.946237],
	[50.080163, 8.947754],
	[50.079679, 8.948958],
	[50.079394, 8.950287],
	[50.079169, 8.952108],
	[50.079303, 8.954142],
	[50.079495, 8.957125],
	[50.079682, 8.958571],
	[50.079748, 8.96042],
	[50.079861, 8.964819],
	[50.079865, 8.965349],
	[50.079796, 8.966837],
	[50.079851, 8.971361],
	[50.079458, 8.973829],
	[50.079064, 8.976172],
	[50.078373, 8.978442],
	[50.076423, 8.98474],
	[50.075619, 8.98648],
	[50.074622, 8.988046],
	[50.073185, 8.989615],
	[50.07221, 8.990249],
	[50.070762, 8.991258],
	[50.069887, 8.991446],
	[50.068128, 8.991245],
	[50.067175, 8.990906],
	[50.061631, 8.986838],
	[50.057561, 8.983782],
	[50.056331, 8.982582],
	[50.054357, 8.979698],
	[50.053443, 8.978161],
	[50.053099, 8.977693],
	[50.052931, 8.977539],
	[50.052196, 8.976836],
	[50.05148, 8.976389],
	[50.050373, 8.976217],
	[50.048766, 8.976479],
	[50.047074, 8.977018],
	[50.045609, 8.977973],
	[50.044553, 8.979071],
	[50.044273, 8.979419],
	[50.043692, 8.980312],
	[50.043111, 8.981205],
	[50.042426, 8.982873],
	[50.042102, 8.983696],
	[50.041915, 8.984636],
	[50.041643, 8.986403],
	[50.041521, 8.989036],
	[50.041605, 8.990069],
	[50.041933, 8.991903],
	[50.043343, 8.997089],
	[50.044038, 8.999311],
	[50.04498, 9.003583],
	[50.045532, 9.008391],
	[50.045573, 9.012205],
	[50.044795, 9.01855],
	[50.043366, 9.02396],
	[50.042984, 9.025231],
	[50.042531, 9.026431],
	[50.040993, 9.029225],
	[50.039588, 9.030878],
	[50.038666, 9.031651],
	[50.038651, 9.031663],
	[50.037531, 9.03208],
	[50.036744, 9.032166],
	[50.035867, 9.032068],
	[50.035092, 9.031848],
	[50.033734, 9.031598],
	[50.028668, 9.030433],
	[50.026303, 9.029938],
	[50.024457, 9.02992],
	[50.022379, 9.030257],
	[50.020464, 9.030849],
	[50.018702, 9.031504],
	[50.016798, 9.033039],
	[50.014831, 9.034828],
	[50.013938, 9.035695],
	[50.012934, 9.036686],
	[50.010899, 9.038977],
	[50.009788, 9.039908],
	[50.008041, 9.041844],
	[50.006922, 9.044211],
	[50.006313, 9.045763],
	[50.004696, 9.049376],
	[50.004539, 9.049721],
	[50.004148, 9.050351],
	[50.003263, 9.05228],
	[50.003037, 9.052811],
	[50.002842, 9.053247],
	[50.002276, 9.0554],
	[50.000782, 9.057295],
	[49.99924, 9.059211],
	[49.997828, 9.060515],
	[49.996306, 9.06195],
	[49.994695, 9.063211],
	[49.992856, 9.063863],
	[49.991132, 9.064275],
	[49.990667, 9.064387],
	[49.989418, 9.064722],
	[49.987655, 9.065064],
	[49.985927, 9.065023],
	[49.985034, 9.065026],
	[49.984055, 9.065042],
	[49.982293, 9.066021],
	[49.981541, 9.066774],
	[49.980891, 9.067426],
	[49.979975, 9.068739],
	[49.97959, 9.069358],
	[49.978535, 9.071591],
	[49.977665, 9.073995],
	[49.976862, 9.076641],
	[49.97669, 9.077339],
	[49.97617, 9.07929],
	[49.975586, 9.081928],
	[49.974962, 9.084581],
	[49.973902, 9.089067],
	[49.973413, 9.09114],
	[49.97335, 9.091806],
	[49.973153, 9.093868],
	[49.973177, 9.094591],
	[49.973342, 9.09738],
	[49.973514, 9.10017],
	[49.973689, 9.102993],
	[49.97377, 9.103761],
	[49.974049, 9.105923],
	[49.974642, 9.108564],
	[49.975332, 9.111095],
	[49.976086, 9.113591],
	[49.976771, 9.116024],
	[49.977439, 9.118603],
	[49.977626, 9.121528],
	[49.977761, 9.124255],
	[49.977648, 9.126741],
];

/** Stops with their matching polyline index (Frankfurt→Aschaffenburg
 * order). Indices snapped to nearest polyline vertex from each stop's
 * known ferry-terminal coords (4 from OSM relation members,
 * 5 approximate). */
interface PrimusStop {
	name: string;
	polyIdx: number;
	/** Outbound departure/pass-through, minutes from 00:00 local Berlin. */
	outboundMin: number;
	/** Inbound (return) arrival, minutes from 00:00 local Berlin. */
	inboundMin: number;
}

const PRIMUS_LINIE_STOPS: PrimusStop[] = [
	{
		name: "Frankfurt Eiserner Steg",
		polyIdx: 0,
		outboundMin: 8 * 60 + 30,
		inboundMin: 20 * 60 + 30,
	},
	{
		name: "Offenbach",
		polyIdx: 41,
		outboundMin: 9 * 60 + 15,
		inboundMin: 19 * 60 + 45,
	},
	{
		name: "Fechenheim",
		polyIdx: 65,
		outboundMin: 9 * 60 + 30,
		inboundMin: 19 * 60 + 20,
	},
	{
		name: "Maintal-Dörnigheim",
		polyIdx: 90,
		outboundMin: 10 * 60 + 0,
		inboundMin: 19 * 60 + 0,
	},
	{
		name: "Hanau-Schloss Philippsruhe",
		polyIdx: 115,
		outboundMin: 10 * 60 + 40,
		inboundMin: 18 * 60 + 30,
	},
	{
		name: "Hanau-Steinheim",
		polyIdx: 130,
		outboundMin: 10 * 60 + 55,
		inboundMin: 18 * 60 + 20,
	},
	{
		name: "Hanau-Großauheim",
		polyIdx: 181,
		outboundMin: 11 * 60 + 5,
		inboundMin: 18 * 60 + 10,
	},
	{
		name: "Seligenstadt",
		polyIdx: 213,
		outboundMin: 12 * 60 + 5,
		inboundMin: 17 * 60 + 15,
	},
	{
		name: "Aschaffenburg",
		polyIdx: 304,
		outboundMin: 14 * 60 + 0,
		inboundMin: 15 * 60 + 50,
	},
];

/** 2026 operating dates (Europe/Berlin), as taken from primus-linie.de. */
const PRIMUS_LINIE_DATES = new Set<string>([
	"2026-06-21",
	"2026-07-01",
	"2026-07-09",
	"2026-07-19",
	"2026-07-26",
	"2026-07-29",
	"2026-08-06",
	"2026-08-20",
	"2026-09-03",
]);

const FERRY_COLOR = "#0088BB";
const TRACKING_URL =
	"https://www.primus-linie.de/de/fahrten/aschaffenburg-ueber-seligenstadt-60";

/** Euclidean-on-degrees; fine for adjacent polyline vertices on the Main. */
function segLen(a: [number, number], b: [number, number]): number {
	return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

function berlinDayAnchor(now: Date): { date: string; midnight: number } {
	const start = dayjs(now).tz("Europe/Berlin").startOf("day");
	return { date: start.format("YYYY-MM-DD"), midnight: start.valueOf() };
}

/** Build waypoints for one direction of a single day's run.
 *
 * Walks the polyline slice between consecutive stops. Within each slice,
 * timestamps are distributed by cumulative Euclidean distance along the
 * segment — so an arm with tight curves (i.e. more polyline points per km)
 * still passes its stop times on schedule; HAFAS-style linear
 * interpolation in `interpolateVehicle` then glides between these
 * timestamped vertices. */
function buildRunWaypoints(
	midnight: number,
	direction: "out" | "in",
): Waypoint[] {
	const stops = PRIMUS_LINIE_STOPS;
	const wps: Waypoint[] = [];
	const poly = PRIMUS_LINIE_POLYLINE;
	const stepSign = direction === "out" ? 1 : -1;
	const indices =
		direction === "out"
			? stops.map((_, i) => i)
			: stops.map((_, i) => stops.length - 1 - i);

	for (let s = 0; s < indices.length - 1; s++) {
		const a = stops[indices[s]];
		const b = stops[indices[s + 1]];
		const aT =
			midnight + (direction === "out" ? a.outboundMin : a.inboundMin) * 60_000;
		const bT =
			midnight + (direction === "out" ? b.outboundMin : b.inboundMin) * 60_000;

		const startIdx = a.polyIdx;
		const endIdx = b.polyIdx;
		const length = Math.abs(endIdx - startIdx);
		if (length === 0) continue;

		const segPoints: [number, number][] = [];
		for (let i = 0; i <= length; i++) {
			segPoints.push(poly[startIdx + stepSign * i]);
		}

		const cum: number[] = [0];
		for (let i = 1; i < segPoints.length; i++) {
			cum.push(cum[i - 1] + segLen(segPoints[i - 1], segPoints[i]));
		}
		const total = cum[cum.length - 1] || 1;

		for (let i = 0; i < segPoints.length; i++) {
			const ratio = cum[i] / total;
			const t = Math.round(aT + ratio * (bT - aT));
			const nxt = segPoints[i + 1] ?? segPoints[i];
			const prv = segPoints[i - 1] ?? segPoints[i];
			const anchor = segPoints[i];
			const from = i === 0 ? anchor : prv;
			const to = i === 0 ? nxt : anchor;
			const heading = toDirGeo(
				bearingDeg({ lat: from[0], lon: from[1] }, { lat: to[0], lon: to[1] }),
			);
			const [lat, lon] = segPoints[i];

			// Skip the shared vertex between consecutive segments — the
			// previous segment already emitted it at the same timestamp.
			if (wps.length && i === 0) continue;
			wps.push({ lat, lon, t, heading });
		}
	}
	return wps;
}

function buildVehicle(
	date: string,
	midnight: number,
	direction: "out" | "in",
): FerryVehicle {
	const waypoints = buildRunWaypoints(midnight, direction);
	const first = waypoints[0];
	const last = waypoints[waypoints.length - 1];
	const firstStop = PRIMUS_LINIE_STOPS[0];
	const lastStop = PRIMUS_LINIE_STOPS[PRIMUS_LINIE_STOPS.length - 1];
	const directionName = direction === "out" ? lastStop.name : firstStop.name;

	return {
		id: `FERRY-PL1-${direction.toUpperCase()}-${date}`,
		name: "PL-1",
		lat: first.lat,
		lon: first.lon,
		direction: directionName,
		heading: first.heading,
		category: "Ferry",
		operator: "Primus-Linie",
		bg: FERRY_COLOR,
		delay: null,
		occupancy: null,
		hasRT: false,
		hasGps: false,
		gpsFixAt: null,
		stationary: false,
		externalTrackingUrl: TRACKING_URL,
		serviceDate: null,
		waypoints,
		// `fetchedAt` drives the client's freshness calculations; use the
		// schedule's last-waypoint timestamp so a post-arrival ferry stops
		// polluting the map in case a stale response is cached.
		fetchedAt: last.t,
	};
}

/** Returns the set of ferries that are visible at `now`, in the sense the
 * live-map uses: "vehicle exists between the first and last waypoint
 * timestamps of its run". A 15-minute pre-roll lets users see the boat
 * waiting at the dock before it departs; HAFAS shows RMV vehicles
 * similarly. */
export function getActiveFerryVehicles(now: Date = new Date()): FerryVehicle[] {
	const { date, midnight } = berlinDayAnchor(now);
	if (!PRIMUS_LINIE_DATES.has(date)) return [];

	const t = now.getTime();
	const preRoll = 15 * 60_000;
	const result: FerryVehicle[] = [];

	for (const dir of ["out", "in"] as const) {
		const v = buildVehicle(date, midnight, dir);
		const first = v.waypoints[0].t - preRoll;
		const last = v.waypoints[v.waypoints.length - 1].t;
		if (t >= first && t <= last) result.push(v);
	}
	return result;
}

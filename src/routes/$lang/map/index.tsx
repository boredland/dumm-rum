import { createFileRoute, Link } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { setResponseHeader } from "@tanstack/react-start/server";
import "leaflet/dist/leaflet.css";
import "leaflet-fullscreen/dist/leaflet.fullscreen.css";
import "leaflet.locatecontrol/dist/L.Control.Locate.min.css";
import { useCallback, useEffect, useRef, useState } from "react";
import { SubscribeModal } from "../../../components/SubscribeModal.tsx";
import {
	fetchBahnExpertPositions,
	isSupportedCategory as isBahnExpertCategory,
	MAX_RMV_BAHN_EXPERT_DRIFT_M,
	type TrainIdentity,
} from "../../../lib/bahn-expert.ts";
import {
	distanceMeters,
	type GpsPath,
	locationAtPercent,
} from "../../../lib/gps-path.ts";
import {
	fetchHeagVehicles,
	heagGpsPath,
	heagHeadingToDirGeo,
	matchHeagToRmv,
	parseHeagFixTime,
} from "../../../lib/heag.ts";
import { type Lang, t } from "../../../lib/i18n.ts";
import {
	AUTH,
	CLIENT,
	cleanLineName,
	decodeEncodedPolyline,
	MGATE_URL,
} from "../../../lib/mgate.ts";

const FRANKFURT_CENTER = { lat: 50.1109, lon: 8.6821 };
const POLL_INTERVAL = 15_000;
const PER_SIZE = 35_000;
/** Animation step between mgate-returned ani frames, in milliseconds.
 * RMV's own live map uses 2000 ms (18 frames over 34 s) — dropping this
 * from 5000 ms (8 frames) to 2000 ms gives us 2.3× denser animation and
 * makes marker motion smoother, matching what the official RMV app does.
 */
const PER_STEP = 2_000;

interface Waypoint {
	lat: number;
	lon: number;
	t: number;
	heading: number;
}

interface Vehicle {
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
	occupancy: "L" | "M" | "H" | null;
	hasRT: boolean;
	/** True when the vehicle's `lat`/`lon` come from a real position
	 * report. As of 2026-04-18 only Flix is surfacing real GPS to this
	 * app — RMV's public mgate `JourneyGeoPos` doesn't expose `aPos`
	 * under any `trainPosMode`, so RMV entries are always false. Kept as
	 * a per-vehicle flag so the indicator logic can light up the moment
	 * any source starts providing it. */
	hasGps: boolean;
	/** Unix-ms timestamp of the last real position fix. Null when the
	 * vehicle has no GPS source (either schedule-interpolated or no age
	 * report returned). HAFAS gives us `aPos` seconds-since-fix; Flix
	 * publishes `location.updated_at` directly. Shown in the popup as a
	 * human-readable age. */
	gpsFixAt: number | null;
	/** Forward trajectory for mid-poll animation of GPS-enriched
	 * vehicles. Walked by `locationAtPercent` at
	 * `(now - gpsFixAt) / windowMs * 100`. Absent or null when the
	 * source hasn't published a trajectory (Flix falls back
	 * to the `waypoints` array — see that instead). */
	gpsPath?: GpsPath | null;
	stationary?: boolean;
	externalTrackingUrl: string | null;
	/** HAFAS service date (`YYYY-MM-DD`). Used to deep-link the popup into
	 * this app's `/$lang/line/:line/day/:date?jid=…` page. Only set for
	 * RMV-sourced vehicles since Flix doesn't live in `journey_runs`. */
	serviceDate: string | null;
	waypoints: Waypoint[];
	fetchedAt: number;
}

const PRODUCT_CLASSES: Record<number, string> = {
	1: "Fernverkehr",
	2: "Fernverkehr",
	4: "Regionalverkehr",
	8: "S-Bahn",
	16: "U-Bahn",
	32: "Tram",
	64: "Bus",
	128: "Bus",
	512: "AST",
};

function classifyProduct(cls: number): string {
	for (const [bit, name] of Object.entries(PRODUCT_CLASSES)) {
		if (cls & Number(bit)) return name;
	}
	return "Other";
}

const CATEGORY_COLORS: Record<string, string> = {
	Fernverkehr: "#EC0016",
	Regionalverkehr: "#EC0016",
	Flixtrain: "#73D700",
	Flixbus: "#44A12C",
	"S-Bahn": "#009757",
	"U-Bahn": "#0065ae",
	Tram: "#ef7d00",
	Bus: "#a71680",
	AST: "#d5a601",
	Other: "#666",
};

/** Format `ms` (a positive duration in milliseconds) as a compact,
 * language-agnostic age string for the popup: `12s`, `2m 3s`, `1h 5m`.
 * Negative / future fixes (clock skew) collapse to `0s`. */
function formatFixAge(ms: number): string {
	const total = Math.max(0, Math.round(ms / 1000));
	if (total < 60) return `${total}s`;
	const m = Math.floor(total / 60);
	const s = total % 60;
	if (m < 60) return s ? `${m}m ${s}s` : `${m}m`;
	const h = Math.floor(m / 60);
	const rm = m % 60;
	return rm ? `${h}h ${rm}m` : `${h}h`;
}

function escapeHtml(s: string): string {
	return s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

const fetchVehicles = createServerFn({ method: "GET" })
	.inputValidator(
		(
			input: unknown,
		): {
			swLat: number;
			swLon: number;
			neLat: number;
			neLon: number;
			products: number;
		} => {
			const o = input as Record<string, unknown>;
			return {
				swLat: Number(o.swLat) || 49.9,
				swLon: Number(o.swLon) || 8.4,
				neLat: Number(o.neLat) || 50.3,
				neLon: Number(o.neLon) || 8.9,
				products: Number(o.products) || 1023,
			};
		},
	)
	.handler(
		async ({ data }): Promise<{ vehicles: Vehicle[]; serverTime: number }> => {
			// Cloudflare keys on the full URL including the query, so the
			// cache splits per bounding-box + products combo. Users in the
			// same area at the same zoom share edge hits; panning into a new
			// tile triggers a miss as expected. 5 s edge TTL is short enough
			// that the animation stays in sync with HAFAS's 15 s poll but
			// absorbs concurrent fan-outs during bursts.
			setResponseHeader(
				"Cache-Control",
				"public, max-age=5, s-maxage=10, stale-while-revalidate=30",
			);

			// HAFAS's JourneyGeoPos quietly returns zero journeys when the
			// request rect is below ~8 km on either axis — probed
			// 2026-04-19 over Siegburg, empty rows under 4-5 km, partial
			// over 8-10 km, full only above ~15 km. At z=15 a typical
			// desktop viewport is ~4-6 km, which made GPS-enriched DB
			// trains vanish (nothing for bahn.expert to attach to while
			// Flix kept rendering independently). Expand the rect around
			// its centre to a floor that's reliably above HAFAS's cutoff;
			// off-viewport markers just sit outside Leaflet's map
			// container, costing nothing visually.
			const MIN_HALF_LAT = 0.09; // ~10 km vertical half-height
			const MIN_HALF_LON = 0.14; // ~10 km horizontal half-width @ 50° N
			const cLat = (data.swLat + data.neLat) / 2;
			const cLon = (data.swLon + data.neLon) / 2;
			const halfLat = Math.max((data.neLat - data.swLat) / 2, MIN_HALF_LAT);
			const halfLon = Math.max((data.neLon - data.swLon) / 2, MIN_HALF_LON);
			const swLat = cLat - halfLat;
			const swLon = cLon - halfLon;
			const neLat = cLat + halfLat;
			const neLon = cLon + halfLon;

			const now = new Date();
			const serverTime = now.getTime();
			const date = now
				.toLocaleDateString("de-DE", {
					year: "numeric",
					month: "2-digit",
					day: "2-digit",
					timeZone: "Europe/Berlin",
				})
				.split(".")
				.reverse()
				.join("");
			const time = now
				.toLocaleTimeString("de-DE", {
					hour: "2-digit",
					minute: "2-digit",
					second: "2-digit",
					hour12: false,
					timeZone: "Europe/Berlin",
				})
				.replace(/:/g, "");

			const body = {
				svcReqL: [
					{
						meth: "JourneyGeoPos",
						req: {
							maxJny: 500,
							onlyRT: false,
							date,
							time,
							rect: {
								llCrd: {
									x: Math.round(swLon * 1_000_000),
									y: Math.round(swLat * 1_000_000),
								},
								urCrd: {
									x: Math.round(neLon * 1_000_000),
									y: Math.round(neLat * 1_000_000),
								},
							},
							perSize: PER_SIZE,
							perStep: PER_STEP,
							ageOfReport: true,
							jnyFltrL: [
								{
									type: "PROD",
									mode: "INC",
									value: String(data.products),
								},
							],
							// RMV's public mgate endpoint does not surface real AVL
							// positions via JourneyGeoPos — probed 2026-04-18:
							// `REPORT` returns zero journeys entirely, and every
							// other mode yields calculated-only data with no
							// `aPos` on `j.pos` even under `ageOfReport: true` +
							// `onlyRT: true`. Stay on CALC so the vehicle list
							// stays populated; `hasGps` will always be false for
							// RMV entries, which is the honest answer here.
							trainPosMode: "CALC",
						},
					},
				],
				client: CLIENT,
				ver: "1.62",
				lang: "deu",
				auth: AUTH,
			};

			// Kick off HEAG in parallel with mgate. HEAG supplies real AVL
			// positions for Darmstadt-area trams/buses — we'll match them
			// onto the RMV vehicles further down. Its timeout (see heag.ts)
			// guarantees it can't slow down the main response path.
			const [resp, heagVehicles] = await Promise.all([
				fetch(MGATE_URL, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(body),
				}),
				fetchHeagVehicles(),
			]);

			if (!resp.ok) return { vehicles: [], serverTime };

			const json = (await resp.json()) as {
				svcResL?: {
					err?: string;
					res?: {
						common?: {
							prodL?: {
								name?: string;
								cls?: number;
								icoX?: number;
								oprX?: number;
								prodCtx?: {
									catOut?: string;
									catOutL?: string;
									matchId?: string;
								};
							}[];
							opL?: { name: string }[];
							polyL?: { crdEncYX?: string }[];
							tcocL?: { r?: number; s?: string }[];
						};
						jnyL?: {
							jid: string;
							date?: string;
							pos: { x: number; y: number; aPos?: number };
							dirTxt?: string;
							dirGeo?: number;
							prodX?: number;
							tcocXL?: number[];
							stopL?: {
								dTimeS?: string;
								dTimeR?: string;
							}[];
							ani?: {
								mSec?: number[];
								dirGeo?: number[];
								polyG?: { polyXL?: number[] };
							};
						}[];
					};
				}[];
			};

			const svc = json.svcResL?.[0];
			if (!svc?.res) return { vehicles: [], serverTime };

			const prodL = svc.res.common?.prodL ?? [];
			const opL = svc.res.common?.opL ?? [];
			const polyL = svc.res.common?.polyL ?? [];
			const tcocL = svc.res.common?.tcocL ?? [];
			const jnyL = svc.res.jnyL ?? [];

			const decodedPolys = new Map<number, [number, number][]>();

			// Collected during the vehicle-map pass: one entry per
			// long-distance DB train so we can batch-enrich them with
			// real GPS from bahn.expert after the mgate parse finishes.
			const bahnExpertInputs: TrainIdentity[] = [];

			const vehicles: Vehicle[] = jnyL.map((j, rmvIndex) => {
				const prod = j.prodX != null ? prodL[j.prodX] : undefined;
				const oprIdx = prod?.oprX;
				const category = classifyProduct(prod?.cls ?? 0);
				const bg = CATEGORY_COLORS[category] ?? "#666";
				const hasRT = (j.stopL ?? []).some((s) => s.dTimeR != null);
				// HAFAS only sets `aPos` (age-of-report in seconds) on `j.pos`
				// when the fix originates from an operator AVL/GPS feed. Its
				// absence means the position was interpolated from the schedule.
				const hasGps = j.pos.aPos != null;
				const gpsFixAt = hasGps ? serverTime - (j.pos.aPos ?? 0) * 1000 : null;

				const ani = j.ani;
				const waypoints: Waypoint[] = [];

				if (ani?.mSec && ani.dirGeo) {
					const polyIdx = ani.polyG?.polyXL?.[0];
					let polyPoints: [number, number][] | undefined;
					if (polyIdx != null) {
						if (!decodedPolys.has(polyIdx)) {
							const encoded = polyL[polyIdx]?.crdEncYX;
							if (encoded)
								decodedPolys.set(polyIdx, decodeEncodedPolyline(encoded));
						}
						polyPoints = decodedPolys.get(polyIdx);
					}

					const numFrames = Math.min(
						ani.mSec.length,
						ani.dirGeo.length,
						polyPoints?.length ?? ani.mSec.length,
					);

					for (let k = 0; k < numFrames; k++) {
						const heading = ani.dirGeo[k];
						const t = serverTime + ani.mSec[k];

						if (polyPoints && k < polyPoints.length) {
							waypoints.push({
								lat: polyPoints[k][0],
								lon: polyPoints[k][1],
								t,
								heading,
							});
						} else {
							waypoints.push({
								lat: j.pos.y / 1_000_000,
								lon: j.pos.x / 1_000_000,
								t,
								heading,
							});
						}
					}
				}

				let delay: number | null = null;
				for (const s of j.stopL ?? []) {
					if (s.dTimeS && s.dTimeR) {
						const sM =
							Number(s.dTimeS.slice(0, 2)) * 60 + Number(s.dTimeS.slice(2, 4));
						const rM =
							Number(s.dTimeR.slice(0, 2)) * 60 + Number(s.dTimeR.slice(2, 4));
						delay = rM - sM;
						break;
					}
				}

				let occupancy: "L" | "M" | "H" | null = null;
				const tcocIdx = j.tcocXL?.[0];
				if (tcocIdx != null && tcocIdx < tcocL.length) {
					const s = tcocL[tcocIdx].s;
					if (s === "L" || s === "M" || s === "H") occupancy = s;
				}

				const RAIL_CATEGORIES = new Set([
					"Fernverkehr",
					"Regionalverkehr",
					"S-Bahn",
				]);
				let externalTrackingUrl: string | null = null;
				if (RAIL_CATEGORIES.has(category)) {
					const depTime = (j.stopL ?? [])[0]?.dTimeS;
					if (depTime && j.date) {
						const y = j.date.slice(0, 4);
						const mo = j.date.slice(4, 6);
						const dy = j.date.slice(6, 8);
						const hh = depTime.slice(0, 2);
						const mm = depTime.slice(2, 4);
						// bahn.expert wants `<Category> <TrainNumber>` (e.g.
						// "RE 25134"), not the line code (e.g. "RE30") —
						// passing the line code makes its parser strip the
						// prefix and find unrelated trains ("EC30" for
						// "RE30"). HAFAS gives us both via prodCtx.
						const cat = prod?.prodCtx?.catOutL?.trim() ?? "";
						const tripNum = prod?.prodCtx?.matchId?.trim() ?? "";
						const trainName =
							cat && tripNum ? `${cat} ${tripNum}` : (prod?.name?.trim() ?? "");
						if (trainName) {
							externalTrackingUrl = `https://bahn.expert/details/${encodeURIComponent(trainName)}/${y}-${mo}-${dy}T${hh}:${mm}:00.000Z`;
						}
						// Same prodCtx info feeds the bahn.expert live-GPS
						// enrichment. Filter to Fernverkehr categories — DB
						// Regio (RE/RB) and S-Bahn journeys resolve cleanly
						// but never have `lastKnownPosition` populated, so
						// querying them wastes round-trip time.
						const journeyNumber = Number(tripNum);
						if (
							Number.isFinite(journeyNumber) &&
							journeyNumber > 0 &&
							cat &&
							isBahnExpertCategory(cat)
						) {
							bahnExpertInputs.push({
								rmvIndex,
								category: cat,
								journeyNumber,
								serviceDate: `${y}-${mo}-${dy}`,
							});
						}
					}
				}

				const name = cleanLineName(
					prod?.name?.trim() ?? "?",
					prod?.prodCtx?.catOutL?.trim() ?? prod?.prodCtx?.catOut?.trim() ?? "",
				);

				return {
					id: j.jid,
					name,
					lat: j.pos.y / 1_000_000,
					lon: j.pos.x / 1_000_000,
					direction: j.dirTxt ?? "",
					heading: j.dirGeo ?? 0,
					category,
					operator: oprIdx != null ? (opL[oprIdx]?.name ?? "") : "",
					bg,
					delay,
					occupancy,
					hasRT,
					hasGps,
					gpsFixAt,
					gpsPath: null,
					externalTrackingUrl,
					serviceDate: j.date
						? `${j.date.slice(0, 4)}-${j.date.slice(4, 6)}-${j.date.slice(6, 8)}`
						: null,
					waypoints,
					fetchedAt: serverTime,
				};
			});

			// Kick off bahn.expert lookups for any DB long-distance trains
			// we found. Runs after the mgate parse because it depends on
			// the `bahnExpertInputs` list the parse populates, but we
			// await it at the end in parallel with the HEAG enrichment
			// pass so the two GPS sources merge without extra latency.
			const bahnExpertPromise = fetchBahnExpertPositions(bahnExpertInputs);

			// Clear the polyline-derived waypoints on enriched vehicles so
			// the client renders the real GPS fix verbatim. The earlier
			// "shift polyline onto fix" trick preserved smooth motion but
			// introduced off-rail artifacts: HAFAS's calc position and
			// bahn.expert's real GPS can disagree by hundreds of meters
			// (fix staleness × train speed), so a parallel-shifted polyline
			// slides the marker along a line parallel to — but off — the
			// actual rails. Better to show the real position statically
			// between polls and let the marker-div CSS transition smooth
			// the per-poll snaps.
			const clearWaypointsForGps = (v: (typeof vehicles)[number]): void => {
				v.waypoints = [];
			};

			if (heagVehicles.length) {
				const matches = matchHeagToRmv(
					vehicles.map((v) => ({
						name: v.name,
						direction: v.direction,
						lat: v.lat,
						lon: v.lon,
					})),
					heagVehicles,
				);
				for (const m of matches) {
					const v = vehicles[m.rmvIndex];
					const fixAt = parseHeagFixTime(m.heag.date);
					v.lat = m.heag.latitude;
					v.lon = m.heag.longitude;
					v.heading = heagHeadingToDirGeo(m.heag.bearing);
					v.hasGps = true;
					v.gpsFixAt = fixAt;
					v.gpsPath = heagGpsPath(m.heag);
					clearWaypointsForGps(v);
					// HEAG's `deviation` is in seconds; convert to the minute
					// scale RMV/Flix use for the `delay` field. Only overwrite
					// when RMV didn't already have a realtime delay so we
					// don't erase a 30-second value that the RMV feed
					// surfaced but HEAG rounded to 0.
					if (v.delay == null && m.heag.deviation != null) {
						v.delay = Math.round(m.heag.deviation / 60);
					}
					// Operator tag so the popup attributes the source
					// correctly — matches the cache-attribution line the
					// Leaflet map already shows for RMV.
					if (!v.operator) v.operator = "HEAG mobilo";
				}
			}

			// Same for DB long-distance trains via bahn.expert, plus any
			// RE / RB that happen to be indexed on adjacent national
			// networks. bahn.expert's `journey.find` matches on
			// `{category, journeyNumber}` without a country hint, so an
			// RB 15 on our list can sometimes resolve against an SNCB
			// service in Belgium. Reject matches whose GPS fix is wildly
			// far from the RMV calc position — the threshold absorbs
			// normal HAFAS-vs-GPS drift while rejecting the cross-border
			// false positives.
			const bahnExpertPositions = await bahnExpertPromise;
			for (const p of bahnExpertPositions) {
				const v = vehicles[p.rmvIndex];
				if (!v) continue;
				const drift = distanceMeters([v.lat, v.lon], [p.lat, p.lon]);
				if (drift > MAX_RMV_BAHN_EXPERT_DRIFT_M) continue;
				v.lat = p.lat;
				v.lon = p.lon;
				v.hasGps = true;
				v.gpsFixAt = p.timeMs;
				v.gpsPath = p.gpsPath;
				clearWaypointsForGps(v);
			}

			return { vehicles, serverTime };
		},
	);

async function fetchFlixVehicles(): Promise<{
	vehicles: Vehicle[];
	serverTime: number;
}> {
	const resp = await fetch("/api/flix/vehicles");
	if (!resp.ok) throw new Error(`flix vehicles HTTP ${resp.status}`);
	return (await resp.json()) as { vehicles: Vehicle[]; serverTime: number };
}

async function fetchFlixRoute(
	uuid: string,
): Promise<[number, number][] | null> {
	const resp = await fetch(`/api/flix/route/${encodeURIComponent(uuid)}`);
	if (!resp.ok) return null;
	return (await resp.json()) as [number, number][] | null;
}

type MapSearch = {
	z?: number;
	lat?: number;
	lon?: number;
	/** Comma-separated categories whose markers are hidden. Absent/empty =
	 * nothing hidden. Keeps the URL short when all layers are visible. */
	hide?: string;
	/** "0" hides the Realtime layer group; anything else = visible. */
	rt?: string;
	/** "0" hides the GPS layer group. */
	gps?: string;
	/** "0" hides the Schedule layer group. */
	sched?: string;
	/** Vehicle id to auto-follow on load — restored from the URL so a
	 * bookmarked / shared link keeps the popup open and the map
	 * panning with the chosen vehicle. Cleared on stopFollowing or
	 * when the vehicle hasn't appeared in responses after ~30 s. */
	follow?: string;
	/** "0" disables the rAF-driven mid-poll animation. Markers still
	 * jump on each 15 s poll and popup ages still tick, but per-frame
	 * interpolation + follow-pan stop — useful on low-power devices
	 * and for reduced-motion preferences. */
	anim?: string;
};

export const Route = createFileRoute("/$lang/map/")({
	head: () => ({
		meta: [{ title: "DummRum — Live Map" }],
	}),
	validateSearch: (search: Record<string, unknown>): MapSearch => ({
		z: typeof search.z === "number" ? search.z : undefined,
		lat: typeof search.lat === "number" ? search.lat : undefined,
		lon: typeof search.lon === "number" ? search.lon : undefined,
		hide: typeof search.hide === "string" ? search.hide : undefined,
		rt: typeof search.rt === "string" ? search.rt : undefined,
		gps: typeof search.gps === "string" ? search.gps : undefined,
		sched: typeof search.sched === "string" ? search.sched : undefined,
		follow: typeof search.follow === "string" ? search.follow : undefined,
		anim: typeof search.anim === "string" ? search.anim : undefined,
	}),
	component: MapPage,
});

type IconType = "S" | "U" | "R" | "bus" | "tram" | "train" | null;

function resolveIconType(category: string): IconType {
	switch (category) {
		case "S-Bahn":
			return "S";
		case "U-Bahn":
			return "U";
		case "Bus":
		case "AST":
			return "bus";
		case "Tram":
			return "tram";
		case "Fernverkehr":
			return "train";
		case "Regionalverkehr":
			return "R";
		case "Flixtrain":
			return "train";
		case "Flixbus":
			return "bus";
		default:
			return null;
	}
}

const ICON_SIZE_BY_ZOOM = [
	14, 14, 14, 14, 14, 14, 14, 14, 14, 14, 16, 18, 22, 26, 32, 38, 44, 50, 54,
];

function getIconSize(zoom: number): number {
	return ICON_SIZE_BY_ZOOM[Math.min(zoom, ICON_SIZE_BY_ZOOM.length - 1)] ?? 30;
}

const RMV_GLYPHS: Record<string, string> = {
	bus: '<path d="M86.75,32c0-1.88-.66-2.45-2.44-2.45H18.54c-1.22,0-1.71.66-1.87,1.79,0,0-3.42,20.1-3.42,23.68v6.7c0,1.22.56,1.88,1.78,1.88h5.02a.04.04,0,0,0,.04-.03,12.03,12.03,0,0,1,23.89,0,.04.04,0,0,0,.04.03h12.77a.04.04,0,0,0,.04-.03,12.03,12.03,0,0,1,23.89,0,.04.04,0,0,0,.04.03h3.55c1.78,0,2.44-.66,2.44-2.45V32zm-68.3,18a.04.04,0,0,1-.04-.04l1.84-15.14c.16-1.15.73-1.15,1.22-1.15h6.61a.04.04,0,0,1,.04.04V50a.04.04,0,0,1-.04.04H18.45zm13.95-4.08a.04.04,0,0,1-.04-.04V33.7a.04.04,0,0,1,.04-.04h13.81a.04.04,0,0,1,.04.04v12.17a.04.04,0,0,1-.04.04H32.4zm18.1,0a.04.04,0,0,1-.04-.04V33.7a.04.04,0,0,1,.04-.04h13.81a.04.04,0,0,1,.04.04v12.17a.04.04,0,0,1-.04.04H50.5zm18.11,0a.04.04,0,0,1-.04-.04V33.7a.04.04,0,0,1,.04-.04h13.89a.04.04,0,0,1,.04.04v12.17a.04.04,0,0,1-.04.04H68.61z"/><circle cx="68.77" cy="66.33" r="8.17"/><circle cx="32.03" cy="66.33" r="8.17"/>',
	tram: '<path fill-rule="evenodd" d="M86.75,39.69c0-2.82-2.31-4.59-5.15-4.59H43l7.42-7.6a.82.82,0,0,0,0-1.15L37.89,13.83a.82.82,0,0,0-1.15,0L24.12,26.35a.82.82,0,0,0,0,1.15l7.44,7.6H21.26c-3.55,0-4.77,1.15-5.15,4.59l-2.84,24.98c-.15,1.16.53,2.31,1.69,2.31h3.52a5.1,5.1,0,0,0,9.81,0,5.1,5.1,0,0,0,9.81,0,5.1,5.1,0,0,0-1.13-3.2h24.65a5.1,5.1,0,0,0-1.13,3.2,5.1,5.1,0,0,0,9.81,0,5.1,5.1,0,0,0,9.81,0,5.1,5.1,0,0,0,0-.38h3.42c1.69,0,2.84-1.15,2.84-2.83V39.69zM18.49,60.7a.82.82,0,0,1-.81-.9l2.13-19.38a.82.82,0,0,1,.81-.73h6.68a.82.82,0,0,1,.82.82V59.88a.82.82,0,0,1-.82.82H18.49zM37.9,34.53a.82.82,0,0,1-1.15,0l-7.13-7.03a.82.82,0,0,1,0-1.16l7.13-7.09a.82.82,0,0,1,1.15,0l7.07,7.09a.82.82,0,0,1,0,1.16L37.9,34.53zM33.02,50.24a.82.82,0,0,1-.82-.82V40.52a.82.82,0,0,1,.82-.82h8.07a.82.82,0,0,1,.82.82v8.91a.82.82,0,0,1-.82.82H33.02zm13.77,0a.82.82,0,0,1-.82-.82V40.52a.82.82,0,0,1,.82-.82h7.83a.82.82,0,0,1,.82.82v8.91a.82.82,0,0,1-.82.82H46.79zm13.54,0a.82.82,0,0,1-.82-.82V40.52a.82.82,0,0,1,.82-.82h7.78a.82.82,0,0,1,.82.82v8.91a.82.82,0,0,1-.82.82H60.33zm13.54,10.46a.82.82,0,0,1-.82-.82V40.5a.82.82,0,0,1,.82-.82h7.99a.82.82,0,0,1,.82.82V59.88a.82.82,0,0,1-.82.82H73.87z"/>',
	train:
		'<path d="M72.32,37.63a5.5,5.5,0,0,0-.09-.45c-.45-1.69-3.48-12.81-6.7-16.02-2.94-2.94-9.8-3.48-15.52-3.48s-12.59.54-15.52,3.48c-2.73,2.73-5.41,11.6-6.44,15.28a11.7,11.7,0,0,0-.44,3.32v24.48c0,5.41,4.01,8.58,8.57,8.58h27.64c4.55,0,8.57-3.16,8.57-8.58V38.45a5.3,5.3,0,0,0-.07-.82zM31.96,37.76a.82.82,0,0,1-.81-1.1l3.16-9.81a.82.82,0,0,1,.8-.59h12.02a.85.85,0,0,1,.85.85v9.8a.85.85,0,0,1-.85.85H31.96zM38.5,68.26a4.1,4.1,0,1,1,4.1-4.1A4.1,4.1,0,0,1,38.5,68.26zm1.76,7.41a.85.85,0,0,0-.85-.85h-2.39a.85.85,0,0,0-.85.85v5.8a.85.85,0,0,0,.85.85h2.39a.85.85,0,0,0,.85-.85V75.67zM50.02,48.88a4.1,4.1,0,1,1,4.1-4.1A4.1,4.1,0,0,1,50.02,48.88zm2.86-11.12a.85.85,0,0,1-.85-.85v-9.8a.85.85,0,0,1,.85-.85h12.03a.82.82,0,0,1,.8.59l3.16,9.8a.82.82,0,0,1-.81,1.1H52.88zM61.51,68.26a4.1,4.1,0,1,1,4.1-4.1A4.1,4.1,0,0,1,61.51,68.26zm2.32,7.41a.85.85,0,0,0-.85-.85h-2.39a.85.85,0,0,0-.85.85v5.8a.85.85,0,0,0,.85.85h2.39a.85.85,0,0,0,.85-.85V75.67z"/>',
	S: '<path d="M69.15,37.62c-2.8-2.59-5.42-4.78-8.45-6.37-4.85-2.56-9.92-4.07-15.44-3.12-2.9.5-4.88,2.32-5.26,4.61-.48,2.92.64,5.32,3.34,6.89,3.42,2,7.3,2.6,11.05,3.55,2.68.68,5.33,1.42,7.94,2.37,11.33,4.12,12.56,16.1,6.69,23.98-5.11,6.86-12.22,9.47-20.47,9.01-7.09-.4-13.55-2.76-19.37-6.93-.86-.62-1.23-1.25-1.2-2.34.08-2.98.03-5.96.03-9.41,1.82,2.18,3.46,4.01,5.38,5.52,5.39,4.22,11.32,6.79,18.29,6.2,2.23-.19,4.24-.98,5.91-2.52,2.83-2.62,2.73-6.39-.26-8.84-1.96-1.61-4.35-2.33-6.72-3.05-4.5-1.36-9.14-2.27-13.44-4.26-4.6-2.13-8.05-5.26-9.23-10.54-1.44-6.48,1.21-13.25,6.71-16.83,8.13-5.29,16.66-4.98,25.39-1.91,2.9,1.02,5.6,2.49,8.09,4.32.47.35,1.03.6,1.03,1.34,0,2.66,0,5.32,0,8.34z"/>',
	U: '<path d="M27.57,42.62V26.77c-.01-.97.21-1.28,1.25-1.26,4.18.06,8.37.07,12.55,0,1.09-.02,1.43.2,1.42,1.35-.05,9.72-.03,19.45-.03,29.17,0,.58-.01,1.16.08,1.73.64,4.04,3.22,6.04,7.47,5.8a8.5,8.5,0,0,0,2.01-.19c3.15-.55,4.89-2.72,5.01-6.3.06-1.78.01-3.55.01-5.33V27.87c-.01-1.02.23-1.34,1.31-1.32,4.23.07,8.46.06,12.69,0,.98-.01,1.17.28,1.17,1.19-.03,9.72-.02,19.45-.02,29.17,0,9.93-4.46,15.58-14.31,17.73-6.28,1.37-12.61,1.23-18.8-.64-7.51-2.27-11.68-7.94-11.75-15.82-.03-4.83,0-9.67,0-14.56z"/>',
	R: '<text x="50" y="78" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="80" font-weight="900">R</text>',
};

function buildIconGlyph(type: IconType, fill: string): string {
	const key =
		type === "S" || type === "U" || type === "R" ? type : (type ?? "");
	const path = RMV_GLYPHS[key];
	if (path) return `<g fill="${fill}">${path}</g>`;
	return `<circle cx="50" cy="50" r="20" fill="${fill}"/>`;
}

const OCCUP_ICONS: Record<string, string> = {
	L: '<svg width="14" height="10" viewBox="0 0 14 10"><circle cx="3" cy="3" r="2" fill="currentColor" opacity=".9"/><path d="M1 10V8a2 2 0 0 1 4 0v2" fill="currentColor" opacity=".9"/><circle cx="8" cy="3" r="2" fill="currentColor" opacity=".25"/><path d="M6 10V8a2 2 0 0 1 4 0v2" fill="currentColor" opacity=".25"/><circle cx="13" cy="3" r="2" fill="currentColor" opacity=".25"/><path d="M11 10V8a2 2 0 0 1 4 0v2" fill="currentColor" opacity=".25"/></svg>',
	M: '<svg width="14" height="10" viewBox="0 0 14 10"><circle cx="3" cy="3" r="2" fill="currentColor" opacity=".9"/><path d="M1 10V8a2 2 0 0 1 4 0v2" fill="currentColor" opacity=".9"/><circle cx="8" cy="3" r="2" fill="currentColor" opacity=".9"/><path d="M6 10V8a2 2 0 0 1 4 0v2" fill="currentColor" opacity=".9"/><circle cx="13" cy="3" r="2" fill="currentColor" opacity=".25"/><path d="M11 10V8a2 2 0 0 1 4 0v2" fill="currentColor" opacity=".25"/></svg>',
	H: '<svg width="14" height="10" viewBox="0 0 14 10"><circle cx="3" cy="3" r="2" fill="currentColor"/><path d="M1 10V8a2 2 0 0 1 4 0v2" fill="currentColor"/><circle cx="8" cy="3" r="2" fill="currentColor"/><path d="M6 10V8a2 2 0 0 1 4 0v2" fill="currentColor"/><circle cx="13" cy="3" r="2" fill="currentColor"/><path d="M11 10V8a2 2 0 0 1 4 0v2" fill="currentColor"/></svg>',
};

function buildVehicleIcon(
	v: Vehicle,
	heading: number,
	size: number,
	showLabel: boolean,
): string {
	const s = size;
	const c = s / 2;
	const r = c * 0.84;
	const iconType = resolveIconType(v.category);
	const glyph = buildIconGlyph(iconType, v.bg);
	const headingDeg = -11.25 * heading;

	const tipDist = r * 1.6;
	const spread = r * 0.55;
	const pointer = v.stationary
		? ""
		: `<g transform="rotate(${headingDeg},${c},${c})"><polygon points="${c + tipDist},${c} ${c + r * 0.6},${c - spread} ${c + r * 0.6},${c + spread}" fill="${v.bg}" stroke="#fff" stroke-width="2" stroke-linejoin="round"/></g>`;

	const ir = r * 0.72;
	const gs = (ir * 2) / 100;
	const go = c - ir;
	const innerGlyph = `<g transform="translate(${go},${go}) scale(${gs})">${glyph}</g>`;

	// Stationary markers: swap the directional arrow for a dashed halo so
	// the user sees "parked" rather than thinking the marker is frozen
	// mid-move.
	const stationaryHalo = v.stationary
		? `<circle cx="${c}" cy="${c}" r="${r + 4}" fill="none" stroke="${v.bg}" stroke-width="2" stroke-dasharray="3 3" opacity="0.6"/>`
		: "";

	// Real-GPS badge: three ascending signal bars at the pin's top-right
	// so users can tell at a glance which markers are ground-truth AVL
	// fixes (Flix live feed, HEAG mobilo, bahn.expert for DB Fernverkehr)
	// vs the polyline-calc interpolation we render for everything else.
	// Bars light up sequentially via CSS keyframes, mirroring phone cell-
	// reception animations so the intent reads as "live signal."
	let gpsBadge = "";
	if (v.hasGps) {
		const bx = c + r * 0.7;
		const by = c - r * 0.7;
		// Scale the whole badge with the pin; the base unit is the
		// radius of the inner circle's top-right corner. br ≈ 3-5 px
		// at the map's default zoom, ~6-8 px when zoomed in to label
		// level. Bars share the same origin point as the old dot so the
		// layout feels familiar.
		const badgeW = Math.max(6, r * 0.65);
		const badgeH = Math.max(5, r * 0.55);
		const barW = badgeW / 5.4;
		const barGap = barW * 0.4;
		const left = bx - badgeW / 2;
		const bottom = by + badgeH / 2;
		const padX = barW * 0.6;
		const padY = barW * 0.4;
		// Rounded white backing rectangle behind the bars so they stay
		// legible over any underlying category colour or map tile.
		const bg = `<rect x="${left - padX}" y="${bottom - badgeH - padY}" width="${badgeW + padX * 2}" height="${badgeH + padY * 2}" rx="${padX}" fill="#fff" stroke="rgba(0,0,0,0.15)" stroke-width="0.5"/>`;
		const bars = [0.35, 0.65, 1.0]
			.map((frac, idx) => {
				const h = badgeH * frac;
				const x = left + idx * (barW + barGap);
				const y = bottom - h;
				return `<rect class="dummrum-gps-bar dummrum-gps-bar-${idx}" x="${x}" y="${y}" width="${barW}" height="${h}" rx="${barW * 0.2}" fill="#27ae60"/>`;
			})
			.join("");
		gpsBadge = `<g class="dummrum-gps-signal">${bg}${bars}</g>`;
	}

	const pin = `${pointer}${stationaryHalo}<circle cx="${c}" cy="${c}" r="${r}" fill="${v.bg}" stroke="#fff" stroke-width="2"/><circle cx="${c}" cy="${c}" r="${ir}" fill="#fff"/>${innerGlyph}${gpsBadge}`;

	let label = "";
	if (showLabel) {
		const delayColor =
			v.delay != null && v.delay > 2
				? "#c0392b"
				: v.delay != null && v.delay >= 0
					? "#27ae60"
					: "#888";
		const delayText =
			v.delay != null
				? `<span style="background:${delayColor};color:#fff;padding:0 3px;border-radius:2px;margin-left:2px">${v.delay > 0 ? `+${v.delay}` : v.delay}</span>`
				: "";
		const occupIcon = v.occupancy ? OCCUP_ICONS[v.occupancy] : "";
		const occupHtml = occupIcon
			? `<span style="color:#555;margin-left:2px;display:inline-flex;align-items:center">${occupIcon}</span>`
			: "";
		const safeName = escapeHtml(v.name);
		label = `<div style="position:absolute;top:${s + 2}px;left:50%;transform:translateX(-50%);white-space:nowrap;display:inline-flex;align-items:center;gap:0;background:#fff;border:1px solid rgba(0,0,0,.15);padding:1px 4px;border-radius:4px;line-height:1.4;font-family:system-ui,sans-serif;font-size:10px;box-shadow:0 1px 3px rgba(0,0,0,.1)"><span style="background:${v.bg};color:#fff;padding:0 3px;border-radius:2px;font-weight:700">${safeName}</span>${delayText}${occupHtml}</div>`;
	}

	const opacity = v.hasRT || v.hasGps ? 1 : 0.45;
	return `<div style="position:relative;width:${s}px;height:${s}px;opacity:${opacity}"><svg width="${s}" height="${s}" viewBox="0 0 ${s} ${s}" overflow="visible">${pin}</svg>${label}</div>`;
}

function interpolateVehicle(
	v: Vehicle,
	now: number,
): { lat: number; lon: number; heading: number } {
	const wps = v.waypoints;
	const fb = v.heading;
	if (wps.length < 2) return { lat: v.lat, lon: v.lon, heading: fb };

	const h = (wp: Waypoint) => (wp.heading >= 0 ? wp.heading : fb);

	if (now <= wps[0].t)
		return { lat: wps[0].lat, lon: wps[0].lon, heading: h(wps[0]) };
	if (now >= wps[wps.length - 1].t) {
		const last = wps[wps.length - 1];
		return { lat: last.lat, lon: last.lon, heading: h(last) };
	}

	for (let i = 0; i < wps.length - 1; i++) {
		if (now >= wps[i].t && now < wps[i + 1].t) {
			const ratio = (now - wps[i].t) / (wps[i + 1].t - wps[i].t);
			return {
				lat: wps[i].lat + ratio * (wps[i + 1].lat - wps[i].lat),
				lon: wps[i].lon + ratio * (wps[i + 1].lon - wps[i].lon),
				heading: wps[i + 1].heading >= 0 ? wps[i + 1].heading : h(wps[i]),
			};
		}
	}
	const last = wps[wps.length - 1];
	return { lat: last.lat, lon: last.lon, heading: fb };
}

interface RenderedPos {
	lat: number;
	lon: number;
	heading: number;
	t: number;
}

const MAX_HOLD_MS = 60_000;

/** Monotone-forward clamp: when the raw interp would place the vehicle
 * behind the last rendered position along the current heading vector,
 * hold the last position instead — so HAFAS's occasional downward
 * re-prediction doesn't visibly pop the marker backwards. Gives up after
 * MAX_HOLD_MS so a genuinely-correct revision can't freeze the marker
 * forever. Keyed by vehicle id in an external store (typically a ref). */
function clampForward(
	id: string,
	raw: { lat: number; lon: number; heading: number },
	now: number,
	store: Map<string, RenderedPos>,
): { lat: number; lon: number; heading: number } {
	const last = store.get(id);
	if (last) {
		// dirGeo units → compass radians. Forward unit vector in
		// (east, north) = (sin θ, cos θ). Project the raw displacement
		// onto it; negative = backward.
		const headingRad = (raw.heading * 11.25 * Math.PI) / 180;
		const fwdE = Math.sin(headingRad);
		const fwdN = Math.cos(headingRad);
		const dE = raw.lon - last.lon;
		const dN = raw.lat - last.lat;
		const proj = dE * fwdE + dN * fwdN;
		if (proj < 0 && now - last.t < MAX_HOLD_MS) {
			return { lat: last.lat, lon: last.lon, heading: last.heading };
		}
	}
	store.set(id, { lat: raw.lat, lon: raw.lon, heading: raw.heading, t: now });
	return raw;
}

function MapPage() {
	const { lang } = Route.useParams();
	const l = lang as Lang;
	const search = Route.useSearch();
	const navigate = Route.useNavigate();
	const mapRef = useRef<HTMLDivElement>(null);
	const leafletMap = useRef<L.Map | null>(null);
	// Latest view from the URL, for seeding a map build without making the
	// build depend on values the map itself writes back on every moveend.
	const viewRef = useRef({ lat: search.lat, lon: search.lon, z: search.z });
	viewRef.current = { lat: search.lat, lon: search.lon, z: search.z };
	const markersRef = useRef<
		Map<
			string,
			{
				marker: L.Marker;
				iconKey: string;
				layerKey: string;
				popupContent: string;
			}
		>
	>(new Map());
	const vehiclesRef = useRef<Vehicle[]>([]);
	const renderedPosRef = useRef<Map<string, RenderedPos>>(new Map());
	const timeDeltaRef = useRef(0);
	const animRef = useRef<number | null>(null);
	const followIdRef = useRef<string | null>(null);
	// Set true while we programmatically panTo() the followed vehicle so
	// our own "moveend" handler can skip its load/navigate work — otherwise
	// 60fps panning triggers a 60fps fetch storm and freezes the map.
	const programmaticPanRef = useRef(false);
	// Throttle follow-pan to ~10 Hz instead of 60 Hz. panTo is cheap per
	// call but recomputing every marker's container point at 60 Hz isn't.
	const lastFollowPanAtRef = useRef(0);
	const [followName, setFollowName] = useState<string | null>(null);
	const [subscribeInitial, setSubscribeInitial] = useState<{
		line: string;
		direction?: string;
	} | null>(null);
	const userPanRef = useRef(false);
	const followedPolylineRef = useRef<L.Polyline | null>(null);
	/** Last unix-ms timestamp the followed vehicle's id was present in
	 * a fetch response. Updated every successful load; when the gap
	 * exceeds ~2 polls the auto-unfollow fires so the "Following X"
	 * badge doesn't dangle after a train leaves the viewport or
	 * reaches its destination. */
	const followLastSeenRef = useRef<number | null>(null);
	/** When false the rAF loop short-circuits its per-frame marker
	 * updates, leaving only the 15 s poll-driven snaps. Toggled from
	 * the FilterControl + persisted via the `anim` URL param. Ref so
	 * the animate loop can read the current value without a React
	 * dependency cascade. */
	const animationsRef = useRef(search.anim !== "0");

	const clearFollowedPolyline = useCallback(() => {
		const poly = followedPolylineRef.current;
		if (poly) {
			poly.remove();
			followedPolylineRef.current = null;
		}
	}, []);

	const drawFollowedPolyline = useCallback(async (v: Vehicle) => {
		if (v.category !== "Flixtrain" && v.category !== "Flixbus") return;
		const coords = await fetchFlixRoute(v.id);
		if (!coords || !leafletMap.current) return;
		if (followIdRef.current !== v.id) return;
		const L = await import("leaflet");
		if (followIdRef.current !== v.id || !leafletMap.current) return;
		if (followedPolylineRef.current) followedPolylineRef.current.remove();
		followedPolylineRef.current = L.polyline(coords, {
			color: v.bg,
			weight: 4,
			opacity: 0.55,
			dashArray: "6 6",
		}).addTo(leafletMap.current);
	}, []);

	// Start following a vehicle: bump the ref, show the "Following X"
	// badge, draw its route polyline if we have one, and persist the
	// vehicle id to the URL so a refresh / share-link restores the
	// state. Keeps the click handler and the on-mount restore
	// symmetrical — no duplicated state-setting logic.
	const startFollowing = useCallback(
		(v: Vehicle) => {
			followIdRef.current = v.id;
			// Seed the last-seen timestamp so the auto-unfollow grace
			// window starts from *now* rather than from whenever the
			// previous follow session ended.
			followLastSeenRef.current = Date.now();
			setFollowName(v.name);
			userPanRef.current = false;
			clearFollowedPolyline();
			drawFollowedPolyline(v);
			// On a click Leaflet auto-opens the popup; on a URL-restore
			// the user never clicked, so open it manually if the marker
			// is already on the map — saves ~15 s of waiting for the
			// next syncMarkers tick. Defer to the next tick so we don't
			// race Leaflet's own click-to-open handler, which runs after
			// ours and would otherwise fire popupopen twice and leave
			// things in an inconsistent state.
			const entry = markersRef.current.get(v.id);
			if (entry && !entry.marker.isPopupOpen()) {
				setTimeout(() => {
					if (
						followIdRef.current === v.id &&
						entry.marker &&
						!entry.marker.isPopupOpen()
					) {
						entry.marker.openPopup();
					}
				}, 0);
			}
			navigate({
				search: (s) => ({ ...s, follow: v.id }),
				replace: true,
			});
		},
		// Intentionally empty deps — matches the file's existing
		// pattern of calling `navigate` inside `[]`-memoized callbacks.
		// Listing navigate/clearFollowedPolyline would cascade-invalidate
		// load → the polling effect on every render since TanStack's
		// useNavigate is not stable across renders.
		[drawFollowedPolyline, navigate, clearFollowedPolyline],
	);

	const stopFollowing = useCallback(() => {
		const id = followIdRef.current;
		// Null the ref BEFORE closing the popup. Leaflet fires
		// `popupclose` synchronously during closePopup(), and our
		// per-marker popupclose handler calls stopFollowing again if it
		// still sees its id — that produces an infinite recursion
		// unless we clear the ref first.
		followIdRef.current = null;
		followLastSeenRef.current = null;
		setFollowName(null);
		if (id) markersRef.current.get(id)?.marker.closePopup();
		clearFollowedPolyline();
		navigate({
			search: (s) => ({ ...s, follow: undefined }),
			replace: true,
		});
	}, [navigate, clearFollowedPolyline]);
	const [vehicleCount, setVehicleCount] = useState(0);
	const [loading, setLoading] = useState(true);
	const [lastUpdate, setLastUpdate] = useState<Date | null>(null);
	const [countdown, setCountdown] = useState(POLL_INTERVAL / 1000);
	const lastFetchRef = useRef(Date.now());
	const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
	const loadRef = useRef<() => Promise<void>>(async () => {});
	const categoryLayersRef = useRef<Map<string, L.LayerGroup>>(new Map());

	const syncMarkers = useCallback(async () => {
		const map = leafletMap.current;
		if (!map) return;
		const layers = categoryLayersRef.current;
		if (layers.size === 0) return;
		const L = await import("leaflet");
		const existing = markersRef.current;
		const seen = new Set<string>();
		const zoom = map.getZoom();
		const size = getIconSize(zoom);
		const showLabel = zoom >= 15;

		for (const v of vehiclesRef.current) {
			seen.add(v.id);
			const nowAdj = Date.now() + timeDeltaRef.current;
			// Poll-time snap mirrors the animate-loop precedence:
			//   1. gpsPath (HEAG encodedPath, bahn.expert polyline
			//      slice) — walk by elapsed-time percentage.
			//   2. waypoints (calc RMV, Flix) — interpolate by
			//      wall clock. Calc entries also pass through
			//      clampForward to suppress HAFAS's downward-jitter.
			//   3. hasGps without a path — hold at the raw fix.
			let pos: { lat: number; lon: number; heading: number };
			if (v.gpsPath && v.gpsFixAt != null) {
				const elapsed = nowAdj - v.gpsFixAt;
				const pct = (elapsed / v.gpsPath.windowMs) * 100;
				const [pLat, pLon] = locationAtPercent(v.gpsPath.points, pct);
				pos = { lat: pLat, lon: pLon, heading: v.heading };
			} else if (v.hasGps || v.waypoints.length < 2) {
				pos = { lat: v.lat, lon: v.lon, heading: v.heading };
			} else {
				const rawPos = interpolateVehicle(v, nowAdj);
				pos = clampForward(v.id, rawPos, nowAdj, renderedPosRef.current);
			}
			const layerKey = v.hasGps
				? `${v.category} (gps)`
				: `${v.category}${v.hasRT ? "" : " (sched)"}`;
			const layer = layers.get(layerKey);
			if (!layer) continue;
			const isLive = v.hasRT || v.hasGps;
			const iconKey = `${size}|${showLabel}|${v.heading}|${v.category}|${v.delay}|${v.occupancy}|${isLive}|${v.stationary ? 1 : 0}|${v.hasGps ? "g" : ""}`;

			const entry = existing.get(v.id);
			if (entry) {
				entry.marker.setLatLng([pos.lat, pos.lon]);
				if (entry.iconKey !== iconKey) {
					entry.marker.setIcon(
						L.divIcon({
							html: buildVehicleIcon(v, pos.heading, size, showLabel),
							iconSize: [size, size],
							iconAnchor: [size / 2, size / 2],
							className: v.hasGps ? "dummrum-gps-smooth" : "",
						}),
					);
					entry.iconKey = iconKey;
				}
				if (entry.layerKey !== layerKey) {
					entry.marker.remove();
					entry.marker.addTo(layer);
					entry.layerKey = layerKey;
				}
			} else {
				const icon = L.divIcon({
					html: buildVehicleIcon(v, pos.heading, size, showLabel),
					iconSize: [size, size],
					iconAnchor: [size / 2, size / 2],
					className: v.hasGps ? "dummrum-gps-smooth" : "",
				});
				const marker = L.marker([pos.lat, pos.lon], { icon }).addTo(layer);
				marker.on("click", () => {
					const current = vehiclesRef.current.find((cv) => cv.id === v.id);
					startFollowing(current ?? v);
				});
				// User-initiated close (Leaflet's ✕ button, ESC, or click
				// elsewhere) must also clear follow state, otherwise the
				// next syncMarkers tick reopens the popup. Guard against
				// auto-close from clicking a different marker: by that
				// time followIdRef has already been bumped to the new id.
				marker.on("popupclose", () => {
					if (followIdRef.current === v.id) stopFollowing();
				});
				existing.set(v.id, { marker, iconKey, layerKey, popupContent: "" });
			}

			const isFollowed = v.id === followIdRef.current;
			const entryNow = existing.get(v.id);
			if (!entryNow) return;
			const m = entryNow.marker;
			const isFlix = v.category === "Flixtrain" || v.category === "Flixbus";
			const showTracking =
				v.externalTrackingUrl && (isFlix || (v.delay != null && v.delay > 2));
			const trackingLink = showTracking
				? `<br/><a href="${v.externalTrackingUrl}" target="_blank" rel="noopener" style="font-size:11px;color:var(--accent,#0969da)">Tracking info →</a>`
				: "";
			// Deep-link into our own /line/$line/day/$date?jid=… page so
			// clicking the popup jumps to the journey's per-day detail with
			// the correct row highlighted. Only emit for RMV-sourced vehicles
			// (Flix isn't in journey_runs).
			const lineDetailsLink =
				!isFlix && v.serviceDate
					? `<br/><a href="/${l}/line/${encodeURIComponent(v.name.trim())}/day/${v.serviceDate}?jid=${encodeURIComponent(v.id)}" style="font-size:11px;color:var(--accent,#0969da)">Line details →</a>`
					: "";
			// Subscribe link (RMV only) — clicked via event delegation up
			// to the MapPage's subscribeInitial state, which renders the
			// SubscribeModal. Flix isn't in journey_runs so subscriptions
			// for it wouldn't fire anything.
			const subscribeLink = !isFlix
				? `<br/><a href="#" data-subscribe-line="${escapeHtml(v.name.trim())}" data-subscribe-direction="${escapeHtml(v.direction)}" style="font-size:11px;color:var(--accent,#0969da)">${t(l, "subscribe.cta.button")}</a>`
				: "";
			// Position-source line. Real GPS fixes get a green dot + a
			// "GPS <age>" label that ticks every second via the
			// dummrum-gps-age DOM updater (see its useEffect). We
			// stash the fix moment as a data attribute (adjusted by the
			// server/client clock skew so `Date.now() - fixAt` matches
			// what the operator actually reported) plus the i18n `now`
			// label and `ago` template so the tick doesn't need access
			// to any React state. Schedule-calculated vehicles get a
			// muted "~" so the distinction is visible even without the
			// signal-bars badge.
			let positionLine = "";
			if (v.hasGps && v.gpsFixAt != null) {
				const ageMs = Date.now() + timeDeltaRef.current - v.gpsFixAt;
				const initialLabel =
					ageMs < 1500
						? t(l, "map.gps_fix_now")
						: t(l, "map.gps_fix_ago", { t: formatFixAge(ageMs) });
				const clientFixAt = v.gpsFixAt - timeDeltaRef.current;
				const nowLabel = t(l, "map.gps_fix_now");
				// `t(…, { t: "{t}" })` preserves the `{t}` placeholder
				// so the DOM tick can substitute the rolling age later.
				const agoTemplate = t(l, "map.gps_fix_ago", { t: "{t}" });
				// Outer span holds the dot + text side-by-side; inner
				// span.dummrum-gps-age carries the data attrs and is the
				// only element the DOM updater rewrites (keeps the green
				// dot out of harm's way when `textContent = …` fires).
				positionLine = `<br/><span style="font-size:10px;opacity:.7;display:inline-flex;align-items:center;gap:3px"><span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:#27ae60"></span><span class="dummrum-gps-age" data-fix-at="${clientFixAt}" data-now="${escapeHtml(nowLabel)}" data-ago="${escapeHtml(agoTemplate)}">${escapeHtml(initialLabel)}</span></span>`;
			} else {
				positionLine = `<br/><span style="font-size:10px;opacity:.55;display:inline-flex;align-items:center;gap:3px"><span style="display:inline-block;width:7px;text-align:center;color:#888;font-weight:700">~</span>${escapeHtml(t(l, "map.gps_fix_calc"))}</span>`;
			}
			const content = `<strong>${escapeHtml(v.name)}</strong><br/>→ ${escapeHtml(v.direction)}${v.operator ? `<br/><span style="opacity:.7">${escapeHtml(v.operator)}</span>` : ""}${positionLine}${lineDetailsLink}${subscribeLink}${trackingLink}`;

			// Update popup content in-place via setPopupContent so we
			// don't fire a spurious popupclose on every poll when the
			// content's dynamic bits (GPS fix age, delay) change. The
			// previous unbind/bind dance closed the popup, causing
			// popupclose to fire — which was interpreted as "user
			// dismissed" and torn down the follow state.
			if (entryNow.popupContent !== content) {
				if (m.getPopup()) {
					m.setPopupContent(content);
				} else {
					m.bindPopup(content, {
						offset: [0, -(size / 2 + 4)],
						autoPan: false,
					});
				}
				entryNow.popupContent = content;
			}
			if (isFollowed && !m.isPopupOpen()) m.openPopup();
		}

		for (const [id, entry] of existing) {
			if (!seen.has(id)) {
				entry.marker.remove();
				existing.delete(id);
				renderedPosRef.current.delete(id);
			}
		}
	}, [stopFollowing, startFollowing, l]);

	const load = useCallback(async () => {
		if (!leafletMap.current) return;
		const bounds = leafletMap.current.getBounds();
		const sw = bounds.getSouthWest();
		const ne = bounds.getNorthEast();
		try {
			const [rmvRes, flixRes] = await Promise.allSettled([
				fetchVehicles({
					data: {
						swLat: sw.lat,
						swLon: sw.lng,
						neLat: ne.lat,
						neLon: ne.lng,
						products: 1023,
					},
				}),
				fetchFlixVehicles(),
			]);

			const vehicles: Vehicle[] = [];
			let serverTime = Date.now();
			if (rmvRes.status === "fulfilled") {
				vehicles.push(...rmvRes.value.vehicles);
				serverTime = rmvRes.value.serverTime;
			}
			if (flixRes.status === "fulfilled") {
				vehicles.push(...flixRes.value.vehicles);
			} else {
				console.warn("flix fetch failed:", flixRes.reason);
			}
			timeDeltaRef.current = serverTime - Date.now();
			// No carryover: each fetch's waypoints are HAFAS's authoritative
			// animation for the new horizon starting at serverTime. Mixing
			// our last-extrapolated position into waypoints[0] creates a
			// "gradual rewind" segment from our overshoot back to HAFAS's
			// fresh prediction — worse than the tiny one-off pop the jump
			// to waypoints[0] produces. This matches RMV's own map.
			vehiclesRef.current = vehicles;
			setVehicleCount(vehicles.length);
			setLastUpdate(new Date());
			lastFetchRef.current = Date.now();
			setCountdown(POLL_INTERVAL / 1000);

			// Auto-unfollow when the tracked vehicle has been absent from
			// responses for ~2 polls. Either it left the viewport, HAFAS
			// quietly dropped it, or the journey ended — the "Following X"
			// badge has nothing real to track at that point.
			const followId = followIdRef.current;
			if (followId) {
				if (vehicles.some((v) => v.id === followId)) {
					followLastSeenRef.current = Date.now();
				} else if (
					followLastSeenRef.current != null &&
					Date.now() - followLastSeenRef.current > 30_000
				) {
					stopFollowing();
				}
			}

			await syncMarkers();
		} catch {
			/* network error, keep stale data */
		}
		setLoading(false);
	}, [syncMarkers, stopFollowing]);

	loadRef.current = load;

	useEffect(() => {
		if (!mapRef.current || leafletMap.current) return;

		let cancelled = false;

		(async () => {
			const L = await import("leaflet");
			if (cancelled) return;

			await import("leaflet-fullscreen");

			// Read through a ref: these seed the initial view only, and the
			// map writes them back to the URL on every moveend. Reading
			// `search` directly would put them in this effect's deps, so
			// each pan or zoom would tear the map down and rebuild it.
			const { lat, lon, z } = viewRef.current;
			const initLat = lat ?? FRANKFURT_CENTER.lat;
			const initLon = lon ?? FRANKFURT_CENTER.lon;
			const initZoom = z ?? 13;

			if (!mapRef.current) return;
			const map = L.map(mapRef.current, {
				center: [initLat, initLon],
				zoom: initZoom,
				zoomControl: false,
				fullscreenControl: { position: "topright" },
			});

			L.control.zoom({ position: "topright" }).addTo(map);

			const lc = await import("leaflet.locatecontrol");
			const locateFactory = (
				lc as unknown as {
					locate: (opts: Record<string, unknown>) => L.Control;
				}
			).locate;
			locateFactory({
				position: "topright",
				flyTo: true,
				keepCurrentZoomLevel: true,
				strings: { title: "My location" },
			}).addTo(map);

			L.tileLayer("https://tileserver.memomaps.de/tilegen/{z}/{x}/{y}.png", {
				maxZoom: 18,
				attribution:
					'Map © <a href="https://memomaps.de/">MeMoMaps</a> · Data © <a href="https://www.openstreetmap.org/copyright">OSM</a>',
			}).addTo(map);

			leafletMap.current = map;

			const layers = new Map<string, L.LayerGroup>();
			const CATS = [
				"Fernverkehr",
				"Regionalverkehr",
				"Flixtrain",
				"Flixbus",
				"S-Bahn",
				"U-Bahn",
				"Tram",
				"Bus",
				"AST",
				"Other",
			];
			// Each LayerGroup declares the credit for its data source. The
			// default attribution control dedupes identical strings, so the
			// same string across 16 groups shows up once; removing all groups
			// for a source (e.g. both Flix categories toggled off) drops the
			// credit until something from that source is re-added.
			const FLIX_CATS = new Set(["Flixtrain", "Flixbus"]);
			// Attribution per category. The RMV base string is shared across
			// every calc-only layer (Leaflet dedupes identical strings); the
			// enriched categories append their live-GPS source so credits
			// appear whenever that layer has markers on screen. Tram + Bus
			// carry the HEAG credit globally because we can't predict at
			// layer-create time whether the current viewport will happen to
			// include Darmstadt — a small overclaim we accept to keep the
			// attribution text stable as users pan across the region.
			const RMV_BASE = 'Vehicles © <a href="https://www.rmv.de">RMV</a>';
			const attrFor = (cat: string) => {
				if (FLIX_CATS.has(cat))
					return 'Vehicles © <a href="https://www.flixbus.com">FlixBus</a>';
				if (cat === "Fernverkehr")
					return `${RMV_BASE} · live GPS via <a href="https://bahn.expert">bahn.expert</a>`;
				if (cat === "Tram" || cat === "Bus")
					return `${RMV_BASE} · Darmstadt GPS © <a href="https://www.heagmobilo.de">HEAG mobilo</a>`;
				return RMV_BASE;
			};
			for (const cat of CATS) {
				const attribution = attrFor(cat);
				layers.set(cat, L.layerGroup([], { attribution }).addTo(map));
				layers.set(
					`${cat} (gps)`,
					L.layerGroup([], { attribution }).addTo(map),
				);
				layers.set(
					`${cat} (sched)`,
					L.layerGroup([], { attribution }).addTo(map),
				);
			}
			categoryLayersRef.current = layers;

			const allRt = CATS.map((c) => layers.get(c)).filter(Boolean) as L.Layer[];
			const allGps = CATS.map((c) => layers.get(`${c} (gps)`)).filter(
				Boolean,
			) as L.Layer[];
			const allSched = CATS.map((c) => layers.get(`${c} (sched)`)).filter(
				Boolean,
			) as L.Layer[];

			// Initial visibility state is derived from the search params on
			// mount; subsequent changes are driven by the control itself,
			// which both toggles the layer and reflects the state back into
			// the URL via `navigate`.
			const hiddenCats = new Set<string>(
				(search.hide ?? "").split(",").filter(Boolean),
			);
			let rtVisible = search.rt !== "0";
			let gpsVisible = search.gps !== "0";
			let schedVisible = search.sched !== "0";
			let animEnabled = animationsRef.current;

			const applyCatVisibility = (cat: string) => {
				const rtG = layers.get(cat);
				const gpsG = layers.get(`${cat} (gps)`);
				const schedG = layers.get(`${cat} (sched)`);
				if (!rtG || !gpsG || !schedG) return;
				const hidden = hiddenCats.has(cat);
				if (hidden || !rtVisible) map.removeLayer(rtG);
				else map.addLayer(rtG);
				if (hidden || !gpsVisible) map.removeLayer(gpsG);
				else map.addLayer(gpsG);
				if (hidden || !schedVisible) map.removeLayer(schedG);
				else map.addLayer(schedG);
			};
			for (const cat of CATS) applyCatVisibility(cat);

			const syncSearch = () => {
				navigate({
					search: (s) => ({
						...s,
						hide: hiddenCats.size
							? Array.from(hiddenCats).join(",")
							: undefined,
						rt: rtVisible ? undefined : "0",
						gps: gpsVisible ? undefined : "0",
						sched: schedVisible ? undefined : "0",
						anim: animEnabled ? undefined : "0",
					}),
					replace: true,
				});
			};

			const FilterControl = L.Control.extend({
				onAdd() {
					const el = L.DomUtil.create("div", "leaflet-bar leaflet-control");
					Object.assign(el.style, {
						background: "#fff",
						color: "#333",
						fontSize: "11px",
						lineHeight: "1.8",
						overflow: "hidden",
					});
					L.DomEvent.disableClickPropagation(el);
					L.DomEvent.disableScrollPropagation(el);

					// Collapsed by default: the full layer panel is tall enough
					// on mobile that it hides half the map. The toggle button
					// always shows the same stacked-sheets glyph Google Maps
					// and Leaflet's built-in Layers control both use.
					const toggle = document.createElement("button");
					toggle.type = "button";
					toggle.setAttribute("aria-label", "Toggle layers");
					toggle.setAttribute("aria-expanded", "false");
					Object.assign(toggle.style, {
						display: "flex",
						alignItems: "center",
						justifyContent: "center",
						gap: "4px",
						width: "30px",
						height: "30px",
						padding: "0",
						background: "transparent",
						border: "none",
						color: "inherit",
						cursor: "pointer",
						font: "inherit",
					});
					toggle.innerHTML =
						'<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/></svg>';
					el.appendChild(toggle);

					const body = document.createElement("div");
					Object.assign(body.style, {
						padding: "0 8px 6px",
						maxHeight: "70vh",
						overflowY: "auto",
						display: "none",
					});
					el.appendChild(body);

					let expanded = false;
					const setExpanded = (next: boolean) => {
						expanded = next;
						body.style.display = next ? "block" : "none";
						toggle.setAttribute("aria-expanded", next ? "true" : "false");
						if (next) {
							toggle.style.width = "auto";
							toggle.style.height = "auto";
							toggle.style.padding = "6px 8px";
							toggle.style.justifyContent = "flex-start";
						} else {
							toggle.style.width = "30px";
							toggle.style.height = "30px";
							toggle.style.padding = "0";
							toggle.style.justifyContent = "center";
						}
					};
					toggle.addEventListener("click", () => setExpanded(!expanded));

					const addHeading = (text: string) => {
						const h = document.createElement("div");
						h.textContent = text;
						Object.assign(h.style, {
							fontWeight: "700",
							fontSize: "9px",
							textTransform: "uppercase",
							letterSpacing: "0.05em",
							opacity: "0.5",
							marginTop: "6px",
							marginBottom: "1px",
						});
						body.appendChild(h);
					};

					const addToggle = (
						icon: string,
						label: string,
						checked: boolean,
						onChange: (next: boolean) => void,
					) => {
						const row = document.createElement("label");
						Object.assign(row.style, {
							display: "flex",
							alignItems: "center",
							gap: "3px",
							cursor: "pointer",
							whiteSpace: "nowrap",
						});
						const cb = document.createElement("input");
						cb.type = "checkbox";
						cb.checked = checked;
						cb.style.margin = "0";
						row.appendChild(cb);
						row.insertAdjacentHTML("beforeend", icon + label);
						cb.addEventListener("change", () => onChange(cb.checked));
						body.appendChild(row);
					};

					const catIcon = (cat: string) => {
						const color = CATEGORY_COLORS[cat] ?? "#666";
						const glyph = buildIconGlyph(resolveIconType(cat), "#fff");
						return `<svg width="16" height="16" viewBox="0 0 100 100" style="vertical-align:middle"><circle cx="50" cy="50" r="46" fill="${color}"/>${glyph}</svg>`;
					};

					addHeading("Data");
					addToggle(
						'<svg width="16" height="16" viewBox="0 0 16 16" style="vertical-align:middle"><circle cx="8" cy="8" r="7" fill="#27ae60"/><path d="M5 8l2 2 4-4" stroke="#fff" stroke-width="2.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>',
						` ${t(l, "map.layer_gps")}`,
						gpsVisible,
						(next) => {
							gpsVisible = next;
							for (const g of allGps)
								(next ? map.addLayer : map.removeLayer).call(map, g);
							for (const cat of CATS) applyCatVisibility(cat);
							syncSearch();
						},
					);
					addToggle(
						'<svg width="16" height="16" viewBox="0 0 16 16" style="vertical-align:middle"><circle cx="8" cy="8" r="7" fill="#27ae60"/><text x="8" y="11.5" text-anchor="middle" font-size="9" font-weight="bold" fill="#fff">RT</text></svg>',
						` ${t(l, "map.layer_realtime")}`,
						rtVisible,
						(next) => {
							rtVisible = next;
							for (const g of allRt)
								(next ? map.addLayer : map.removeLayer).call(map, g);
							// Re-apply hidden-category rule so a rt-toggle doesn't
							// show hidden categories.
							for (const cat of CATS) applyCatVisibility(cat);
							syncSearch();
						},
					);
					addToggle(
						'<svg width="16" height="16" viewBox="0 0 16 16" style="vertical-align:middle"><circle cx="8" cy="8" r="7" fill="#999" opacity=".45"/><text x="8" y="11" text-anchor="middle" font-size="7" font-weight="bold" fill="#fff">SCH</text></svg>',
						` ${t(l, "map.layer_schedule")}`,
						schedVisible,
						(next) => {
							schedVisible = next;
							for (const g of allSched)
								(next ? map.addLayer : map.removeLayer).call(map, g);
							for (const cat of CATS) applyCatVisibility(cat);
							syncSearch();
						},
					);
					// Disables rAF-driven mid-poll marker motion. Useful on
					// low-power devices or for users who find the motion
					// distracting. Popup ages still tick and markers still
					// snap on each poll, so the feature degrades gracefully
					// to the slower-updating view.
					addToggle(
						'<svg width="16" height="16" viewBox="0 0 16 16" style="vertical-align:middle"><path d="M8 2v2m0 8v2m6-6h-2M4 8H2m9.07-3.07l-1.41 1.41M6.34 9.66l-1.41 1.41m0-6.14l1.41 1.41m3.32 3.32l1.41 1.41" stroke="#666" stroke-width="1.2" stroke-linecap="round" fill="none"/><circle cx="8" cy="8" r="1.5" fill="#666"/></svg>',
						" Animations",
						animEnabled,
						(next) => {
							animEnabled = next;
							animationsRef.current = next;
							syncSearch();
						},
					);
					addHeading("Vehicles");
					for (const cat of CATS) {
						if (cat === "Other") continue;
						const c = cat;
						addToggle(catIcon(c), ` ${c}`, !hiddenCats.has(c), (next) => {
							if (next) hiddenCats.delete(c);
							else hiddenCats.add(c);
							applyCatVisibility(c);
							syncSearch();
						});
					}

					return el;
				},
			});
			new FilterControl({ position: "topright" }).addTo(map);

			map.on("dragstart", () => {
				userPanRef.current = true;
				stopFollowing();
			});

			// Empty-map click (not on a marker — Leaflet's marker click
			// doesn't propagate to the map "click" event): unfollow and
			// close the popup.
			map.on("click", () => {
				stopFollowing();
			});

			map.on("moveend", () => {
				// Skip the refetch / URL-update churn when the move was
				// triggered by our own follow-pan. Otherwise the animation
				// loop's 60 fps panTo fires moveend 60×/s, each of which
				// kicks off a refetch + navigate — which freezes the map.
				if (programmaticPanRef.current) return;
				loadRef.current?.();
				const c = map.getCenter();
				const z = map.getZoom();
				// Merge into the existing search so moveend doesn't wipe
				// hide/rt/sched/follow every time the user pans or zooms.
				navigate({
					search: (s) => ({
						...s,
						z: Math.round(z),
						lat: Math.round(c.lat * 1e5) / 1e5,
						lon: Math.round(c.lng * 1e5) / 1e5,
					}),
					replace: true,
				});
			});

			map.on("zoomend", () => {
				syncMarkers();
			});

			load();
		})();

		return () => {
			cancelled = true;
			if (leafletMap.current) {
				leafletMap.current.remove();
				leafletMap.current = null;
			}
			// map.remove() detaches every marker with it. Without this the
			// next syncMarkers finds stale entries, takes the setLatLng
			// path instead of addTo, and the vehicles never reappear —
			// only ids first seen after the rebuild get drawn.
			markersRef.current.clear();
			categoryLayersRef.current.clear();
		};
		// search.lat/lon/z are deliberately absent: they are seeded from
		// viewRef above, and moveend writes them back on every pan and
		// zoom. Including them would make the map rebuild itself.
	}, [
		search.sched,
		search.hide,
		navigate,
		syncMarkers,
		search.rt,
		stopFollowing,
		load,
		search.gps,
		l,
	]);

	useEffect(() => {
		if (intervalRef.current) clearInterval(intervalRef.current);
		intervalRef.current = setInterval(() => loadRef.current?.(), POLL_INTERVAL);
		load();
		return () => {
			if (intervalRef.current) clearInterval(intervalRef.current);
		};
	}, [load]);

	// Restore follow-state from the URL on mount (and whenever the
	// `follow` param changes externally, e.g. via Back/Forward). Waits
	// for the first poll to populate vehicles, then hands off to
	// startFollowing exactly like a click would. Gives up after 30 s
	// so a stale bookmark doesn't keep spinning forever — most journeys
	// complete well within the service day.
	useEffect(() => {
		const targetId = search.follow;
		if (!targetId) return;
		if (followIdRef.current === targetId) return;
		let cancelled = false;
		const tryRestore = () => {
			if (cancelled) return false;
			const v = vehiclesRef.current.find((vv) => vv.id === targetId);
			if (!v) return false;
			startFollowing(v);
			return true;
		};
		if (tryRestore()) return;
		const check = setInterval(() => {
			if (tryRestore()) clearInterval(check);
		}, 500);
		const giveUp = setTimeout(() => clearInterval(check), 30_000);
		return () => {
			cancelled = true;
			clearInterval(check);
			clearTimeout(giveUp);
		};
	}, [search.follow, startFollowing]);

	useEffect(() => {
		const animate = () => {
			// When animations are disabled the rAF loop is still scheduled
			// (so toggling back on resumes immediately without re-
			// subscribing the effect) but we skip every per-frame
			// computation. Marker positions then only change on each
			// 15 s poll via syncMarkers.
			if (!animationsRef.current) {
				animRef.current = requestAnimationFrame(animate);
				return;
			}
			const now = Date.now() + timeDeltaRef.current;
			const existing = markersRef.current;
			const nowPerf = performance.now();
			let followPos: { lat: number; lon: number } | null = null;
			for (const v of vehiclesRef.current) {
				const entry = existing.get(v.id);
				if (!entry) continue;
				// Animation source precedence:
				//   1. gpsPath — HEAG / bahn.expert forward trajectory,
				//      walked by elapsed-time percentage.
				//   2. waypoints — HAFAS ani frames (calc RMV) or
				//      Flix-computed forward waypoints.
				//   3. static fix — GPS vehicle without a path (HEAG
				//      offline, bahn.expert speed=0 / polyline mismatch),
				//      already placed by syncMarkers, no per-frame work.
				let pos: { lat: number; lon: number } | null = null;
				if (v.gpsPath && v.gpsFixAt != null) {
					const elapsed = now - v.gpsFixAt;
					const pct = (elapsed / v.gpsPath.windowMs) * 100;
					const [pLat, pLon] = locationAtPercent(v.gpsPath.points, pct);
					pos = { lat: pLat, lon: pLon };
					entry.marker.setLatLng([pos.lat, pos.lon]);
				} else if (v.waypoints.length >= 2) {
					const rawPos = interpolateVehicle(v, now);
					// clampForward guards against HAFAS's occasional
					// downward re-prediction jitter; real GPS vehicles
					// are authoritative and skip it.
					pos = v.hasGps
						? rawPos
						: clampForward(v.id, rawPos, now, renderedPosRef.current);
					entry.marker.setLatLng([pos.lat, pos.lon]);
				} else if (v.hasGps) {
					pos = { lat: v.lat, lon: v.lon };
				}
				if (pos && v.id === followIdRef.current) followPos = pos;
			}
			// Throttle follow-pan to ~10 Hz (vs 60 Hz) — smooth enough
			// perceptually, 6× less work per second in Leaflet's transform
			// recalc, and fewer moveend events to absorb.
			if (
				followPos &&
				leafletMap.current &&
				!userPanRef.current &&
				nowPerf - lastFollowPanAtRef.current > 100
			) {
				programmaticPanRef.current = true;
				leafletMap.current.panTo([followPos.lat, followPos.lon], {
					animate: false,
				});
				programmaticPanRef.current = false;
				lastFollowPanAtRef.current = nowPerf;
			}
			animRef.current = requestAnimationFrame(animate);
		};
		animRef.current = requestAnimationFrame(animate);
		return () => {
			if (animRef.current != null) cancelAnimationFrame(animRef.current);
		};
	}, []);

	useEffect(() => {
		const tick = setInterval(() => {
			const elapsed = (Date.now() - lastFetchRef.current) / 1000;
			setCountdown(Math.max(0, Math.round(POLL_INTERVAL / 1000 - elapsed)));
		}, 1000);
		return () => clearInterval(tick);
	}, []);

	// Rolling "GPS vor Xs" age in any open popup. syncMarkers
	// regenerates popup content on each poll (~15 s) which resets the
	// data-fix-at attribute to the newest fix; between polls this tick
	// rewrites just the inner text span so the age keeps ticking every
	// second without re-rendering the whole popup. No-op when no
	// popups are open or none is for a GPS-enriched vehicle.
	useEffect(() => {
		const tick = setInterval(() => {
			const spans = document.querySelectorAll<HTMLElement>(".dummrum-gps-age");
			if (spans.length === 0) return;
			const now = Date.now();
			for (const el of spans) {
				const fixAt = Number(el.dataset.fixAt);
				if (!Number.isFinite(fixAt)) continue;
				const ageMs = Math.max(0, now - fixAt);
				const nowLabel = el.dataset.now ?? "";
				const agoTemplate = el.dataset.ago ?? "";
				const label =
					ageMs < 1500
						? nowLabel
						: agoTemplate.replace("{t}", formatFixAge(ageMs));
				if (el.textContent !== label) el.textContent = label;
			}
		}, 1000);
		return () => clearInterval(tick);
	}, []);

	// Delegate clicks on the popup's subscribe link up to React state —
	// we can't pass a live callback through Leaflet's HTML-string popup,
	// so the popup emits a `data-subscribe-line` anchor and the map div
	// catches the click bubbling up from it.
	useEffect(() => {
		const el = mapRef.current;
		if (!el) return;
		const handler = (e: MouseEvent) => {
			const target = (e.target as HTMLElement | null)?.closest?.(
				"[data-subscribe-line]",
			) as HTMLElement | null;
			if (!target) return;
			e.preventDefault();
			setSubscribeInitial({
				line: target.dataset.subscribeLine ?? "",
				direction: target.dataset.subscribeDirection || undefined,
			});
		};
		el.addEventListener("click", handler);
		return () => el.removeEventListener("click", handler);
	}, []);

	return (
		<div className="fixed inset-0 flex flex-col">
			{subscribeInitial && (
				<SubscribeModal
					lang={l}
					initial={subscribeInitial}
					onClose={() => setSubscribeInitial(null)}
				/>
			)}
			<div className="flex items-center gap-2 px-3 py-2 bg-surface border-b border-border z-[1000] overflow-x-auto shrink-0">
				<Link
					to="/$lang"
					params={{ lang: l }}
					className="text-sm font-bold text-fg no-underline hover:text-accent shrink-0"
				>
					← DummRum
				</Link>
				{followName && (
					<>
						<span className="text-border">|</span>
						<span className="text-xs text-fg font-bold shrink-0 flex items-center gap-1">
							Following {followName}
							<button
								type="button"
								onClick={stopFollowing}
								className="text-muted hover:text-fg cursor-pointer"
							>
								✕
							</button>
						</span>
					</>
				)}
				<span className="ml-auto text-xs text-dimmed tabular-nums shrink-0 flex items-center gap-1.5">
					{loading ? "…" : `${vehicleCount} vehicles`}
					{lastUpdate && (
						<>
							{" · "}
							{lastUpdate.toLocaleTimeString(l, {
								hour: "2-digit",
								minute: "2-digit",
								second: "2-digit",
							})}
						</>
					)}
					{!loading && (
						<span
							className="inline-block w-3 h-3 rounded-full border border-dimmed shrink-0"
							title={`Refresh in ${countdown}s`}
							style={{
								background: `conic-gradient(var(--accent) ${(1 - countdown / (POLL_INTERVAL / 1000)) * 360}deg, transparent 0deg)`,
							}}
						/>
					)}
				</span>
			</div>
			<div ref={mapRef} className="flex-1" />
		</div>
	);
}

import { createFileRoute, Link } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Lang } from "../../../lib/i18n.ts";

const MGATE_URL = "https://www.rmv.de/auskunft/bin/jp/mgate.exe";
const AUTH = { type: "AID", aid: "uAWgheC24jhp6GdY" };
const CLIENT = { id: "RMV", type: "WEB", name: "webapp", l: "vs_rmv" };

const FRANKFURT_CENTER = { lat: 50.1109, lon: 8.6821 };
const POLL_INTERVAL = 30_000;
const PER_SIZE = 35_000;
const PER_STEP = 5_000;

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
	icoRes: string;
	bg: string;
	fg: string;
	delay: number | null;
	occupancy: "L" | "M" | "H" | null;
	waypoints: Waypoint[];
	fetchedAt: number;
}

const PRODUCT_CLASSES: Record<number, string> = {
	1: "ICE",
	2: "IC",
	4: "RE/RB",
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

function rgbToHex(r: number, g: number, b: number): string {
	return `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)}`;
}

function decodePolyline(encoded: string): [number, number][] {
	const points: [number, number][] = [];
	let index = 0;
	let lat = 0;
	let lng = 0;
	while (index < encoded.length) {
		let result = 1;
		let shift = 0;
		let b: number;
		do {
			b = encoded.charCodeAt(index++) - 63 - 1;
			result += b << shift;
			shift += 5;
		} while (b >= 0x1f);
		lat += result & 1 ? ~(result >> 1) : result >> 1;
		result = 1;
		shift = 0;
		do {
			b = encoded.charCodeAt(index++) - 63 - 1;
			result += b << shift;
			shift += 5;
		} while (b >= 0x1f);
		lng += result & 1 ? ~(result >> 1) : result >> 1;
		points.push([lat / 1e5, lng / 1e5]);
	}
	return points;
}

function interpolateAlongPolyline(
	polyPoints: [number, number][],
	fraction: number,
): [number, number] {
	if (polyPoints.length === 0) return [0, 0];
	if (polyPoints.length === 1 || fraction <= 0) return polyPoints[0];
	if (fraction >= 1) return polyPoints[polyPoints.length - 1];

	let totalDist = 0;
	const segDists: number[] = [];
	for (let i = 1; i < polyPoints.length; i++) {
		const dlat = polyPoints[i][0] - polyPoints[i - 1][0];
		const dlng = polyPoints[i][1] - polyPoints[i - 1][1];
		const d = Math.sqrt(dlat * dlat + dlng * dlng);
		segDists.push(d);
		totalDist += d;
	}
	if (totalDist === 0) return polyPoints[0];

	let target = fraction * totalDist;
	for (let i = 0; i < segDists.length; i++) {
		if (target <= segDists[i]) {
			const r = target / segDists[i];
			return [
				polyPoints[i][0] + r * (polyPoints[i + 1][0] - polyPoints[i][0]),
				polyPoints[i][1] + r * (polyPoints[i + 1][1] - polyPoints[i][1]),
			];
		}
		target -= segDists[i];
	}
	return polyPoints[polyPoints.length - 1];
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
									x: Math.round(data.swLon * 1_000_000),
									y: Math.round(data.swLat * 1_000_000),
								},
								urCrd: {
									x: Math.round(data.neLon * 1_000_000),
									y: Math.round(data.neLat * 1_000_000),
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
							trainPosMode: "CALC",
						},
					},
				],
				client: CLIENT,
				ver: "1.62",
				lang: "deu",
				auth: AUTH,
			};

			const resp = await fetch(MGATE_URL, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			});

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
							}[];
							opL?: { name: string }[];
							icoL?: {
								res?: string;
								bg?: { r: number; g: number; b: number };
								fg?: { r: number; g: number; b: number };
							}[];
							polyL?: { crdEncYX?: string }[];
							tcocL?: { r?: number; s?: string }[];
						};
						jnyL?: {
							jid: string;
							pos: { x: number; y: number };
							dirTxt?: string;
							dirGeo?: number;
							prodX?: number;
							tcocXL?: number[];
							stopL?: {
								dTimeS?: string;
								dTimeR?: string;
								dTrnCmpSX?: { tcocX?: number[] };
							}[];
							ani?: {
								mSec?: number[];
								dirGeo?: number[];
								proc?: number[];
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
			const icoL = svc.res.common?.icoL ?? [];
			const polyL = svc.res.common?.polyL ?? [];
			const tcocL = svc.res.common?.tcocL ?? [];
			const jnyL = svc.res.jnyL ?? [];

			const decodedPolys = new Map<number, [number, number][]>();

			const vehicles: Vehicle[] = jnyL.map((j) => {
				const prod = j.prodX != null ? prodL[j.prodX] : undefined;
				const oprIdx = prod?.oprX;
				const icoIdx = prod?.icoX;
				const ico =
					icoIdx != null && icoIdx < icoL.length ? icoL[icoIdx] : undefined;

				const category = classifyProduct(prod?.cls ?? 0);
				const CATEGORY_BG: Record<string, string> = {
					ICE: "#000000",
					IC: "#000000",
					"RE/RB": "#000000",
					"S-Bahn": "#009757",
					"U-Bahn": "#0065ae",
					Tram: "#d87f3f",
					Bus: "#a71680",
					AST: "#d5a601",
				};
				const bg =
					ico?.bg && (ico.bg.r || ico.bg.g || ico.bg.b)
						? rgbToHex(ico.bg.r, ico.bg.g, ico.bg.b)
						: (CATEGORY_BG[category] ?? "#666");
				const fg = ico?.fg ? rgbToHex(ico.fg.r, ico.fg.g, ico.fg.b) : "#fff";

				const ani = j.ani;
				const waypoints: Waypoint[] = [];

				if (ani?.mSec && ani.proc && ani.dirGeo) {
					const polyIdx = ani.polyG?.polyXL?.[0];
					let polyPoints: [number, number][] | undefined;
					if (polyIdx != null) {
						if (!decodedPolys.has(polyIdx)) {
							const encoded = polyL[polyIdx]?.crdEncYX;
							if (encoded) decodedPolys.set(polyIdx, decodePolyline(encoded));
						}
						polyPoints = decodedPolys.get(polyIdx);
					}

					for (let k = 0; k < ani.mSec.length; k++) {
						const proc = ani.proc[k];
						const heading = ani.dirGeo[k];
						const t = serverTime + ani.mSec[k];

						if (polyPoints && polyPoints.length > 1) {
							const frac = proc / 100;
							const [lat, lon] = interpolateAlongPolyline(polyPoints, frac);
							waypoints.push({ lat, lon, t, heading });
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

				return {
					id: j.jid,
					name: prod?.name?.trim() ?? "?",
					lat: j.pos.y / 1_000_000,
					lon: j.pos.x / 1_000_000,
					direction: j.dirTxt ?? "",
					heading: j.dirGeo ?? 0,
					category,
					operator: oprIdx != null ? (opL[oprIdx]?.name ?? "") : "",
					icoRes: ico?.res ?? "PROD_GEN",
					bg,
					fg,
					delay,
					occupancy,
					waypoints,
					fetchedAt: serverTime,
				};
			});

			return { vehicles, serverTime };
		},
	);

export const Route = createFileRoute("/$lang/map/")({
	head: () => ({
		meta: [{ title: "DummRum — Live Map" }],
	}),
	component: MapPage,
});

type IconType = "S" | "U" | "bus" | "tram" | "train" | null;

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
		case "ICE":
		case "IC":
		case "RE/RB":
			return "train";
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

function buildIconGlyph(type: IconType, fg: string): string {
	switch (type) {
		case "S":
		case "U":
			return `<text x="12" y="16.5" text-anchor="middle" font-size="15" font-weight="bold" fill="${fg}" font-family="system-ui,sans-serif">${type}</text>`;
		case "bus":
			return `<rect x="5" y="5" width="14" height="9" rx="3" fill="${fg}"/><circle cx="8" cy="17" r="1.5" fill="${fg}"/><circle cx="16" cy="17" r="1.5" fill="${fg}"/>`;
		case "tram":
			return `<rect x="6" y="4" width="12" height="10" rx="2" fill="${fg}"/><line x1="6" y1="8" x2="18" y2="8" stroke="${fg}" stroke-width="1"/><circle cx="8.5" cy="17" r="1.3" fill="${fg}"/><circle cx="15.5" cy="17" r="1.3" fill="${fg}"/>`;
		case "train":
			return `<rect x="6.5" y="4" width="11" height="11" rx="2" fill="${fg}"/><rect x="7.5" y="5" width="9" height="4.5" rx="1" fill="rgba(0,0,0,0.15)"/><circle cx="8.5" cy="18" r="1.3" fill="${fg}"/><circle cx="15.5" cy="18" r="1.3" fill="${fg}"/>`;
		default:
			return `<circle cx="12" cy="12" r="4" fill="${fg}"/>`;
	}
}

const OCCUP_ICONS: Record<string, string> = {
	L: '<svg width="14" height="10" viewBox="0 0 14 10"><circle cx="3" cy="3" r="2" fill="currentColor" opacity=".9"/><path d="M1 10V8a2 2 0 0 1 4 0v2" fill="currentColor" opacity=".9"/><circle cx="8" cy="3" r="2" fill="currentColor" opacity=".25"/><path d="M6 10V8a2 2 0 0 1 4 0v2" fill="currentColor" opacity=".25"/><circle cx="13" cy="3" r="2" fill="currentColor" opacity=".25"/><path d="M11 10V8a2 2 0 0 1 4 0v2" fill="currentColor" opacity=".25"/></svg>',
	M: '<svg width="14" height="10" viewBox="0 0 14 10"><circle cx="3" cy="3" r="2" fill="currentColor" opacity=".9"/><path d="M1 10V8a2 2 0 0 1 4 0v2" fill="currentColor" opacity=".9"/><circle cx="8" cy="3" r="2" fill="currentColor" opacity=".9"/><path d="M6 10V8a2 2 0 0 1 4 0v2" fill="currentColor" opacity=".9"/><circle cx="13" cy="3" r="2" fill="currentColor" opacity=".25"/><path d="M11 10V8a2 2 0 0 1 4 0v2" fill="currentColor" opacity=".25"/></svg>',
	H: '<svg width="14" height="10" viewBox="0 0 14 10"><circle cx="3" cy="3" r="2" fill="currentColor"/><path d="M1 10V8a2 2 0 0 1 4 0v2" fill="currentColor"/><circle cx="8" cy="3" r="2" fill="currentColor"/><path d="M6 10V8a2 2 0 0 1 4 0v2" fill="currentColor"/><circle cx="13" cy="3" r="2" fill="currentColor"/><path d="M11 10V8a2 2 0 0 1 4 0v2" fill="currentColor"/></svg>',
};

function buildVehicleIcon(
	v: Vehicle,
	size: number,
	showLabel: boolean,
): string {
	const s = size;
	const c = s / 2;
	const r = c * 0.84;
	const iconType = resolveIconType(v.category);
	const glyph = buildIconGlyph(iconType, v.bg);
	const headingDeg = v.heading * 11.25;

	const tipLen = r * 0.9;
	const halfSpread = 35;
	const a1 = 90 - halfSpread;
	const a2 = 90 + halfSpread;
	const rad1 = (a1 * Math.PI) / 180;
	const rad2 = (a2 * Math.PI) / 180;
	const x1 = c + r * Math.cos(rad1);
	const y1 = c + r * Math.sin(rad1);
	const x2 = c + r * Math.cos(rad2);
	const y2 = c + r * Math.sin(rad2);
	const tx = c + r + tipLen;
	const ty = c;

	const pin = `<g transform="rotate(${headingDeg},${c},${c})"><path d="M${x1},${y1} A${r},${r} 0 1,0 ${x2},${y2} L${tx},${ty}Z" fill="${v.bg}" stroke="#fff" stroke-width="2"/><circle cx="${c}" cy="${c}" r="${r * 0.7}" fill="#fff"/></g>`;

	const gs = s / 28;
	const go = c - 12 * gs;
	const innerGlyph = `<g transform="translate(${go},${go}) scale(${gs})">${glyph}</g>`;

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
		label = `<div style="position:absolute;top:${s + 2}px;left:50%;transform:translateX(-50%);white-space:nowrap;display:inline-flex;align-items:center;gap:0;background:#fff;border:1px solid rgba(0,0,0,.15);padding:1px 4px;border-radius:4px;line-height:1.4;font-family:system-ui,sans-serif;font-size:10px;box-shadow:0 1px 3px rgba(0,0,0,.1)"><span style="background:${v.bg};color:${v.fg};padding:0 3px;border-radius:2px;font-weight:700">${v.name}</span>${delayText}${occupHtml}</div>`;
	}

	return `<div style="position:relative;width:${s}px;height:${s}px"><svg width="${s}" height="${s}" viewBox="0 0 ${s} ${s}" overflow="visible">${pin}${innerGlyph}</svg>${label}</div>`;
}

const CATEGORY_FILTERS = [
	{ key: "all", label: "All", bit: 1023 },
	{ key: "ICE", label: "ICE/IC", bit: 3 },
	{ key: "RE/RB", label: "RE/RB", bit: 4 },
	{ key: "S-Bahn", label: "S-Bahn", bit: 8 },
	{ key: "U-Bahn", label: "U-Bahn", bit: 16 },
	{ key: "Tram", label: "Tram", bit: 32 },
	{ key: "Bus", label: "Bus", bit: 192 },
] as const;

const CATEGORY_COLORS: Record<string, string> = {
	ICE: "#1a1a1a",
	IC: "#1a1a1a",
	"RE/RB": "#e00",
	"S-Bahn": "#009750",
	"U-Bahn": "#0065ae",
	Tram: "#d87f3f",
	Bus: "#a71680",
	AST: "#d5a601",
	Other: "#666",
};

function interpolateVehicle(
	v: Vehicle,
	now: number,
): { lat: number; lon: number; heading: number } {
	const wps = v.waypoints;
	const fb = v.heading;
	if (wps.length < 2) return { lat: v.lat, lon: v.lon, heading: fb };

	const h = (wp: Waypoint) => (wp.heading >= 0 ? wp.heading : fb);

	if (now <= wps[0].t) return { ...wps[0], heading: h(wps[0]) };
	if (now >= wps[wps.length - 1].t) {
		const last = wps[wps.length - 1];
		return { ...last, heading: h(last) };
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
	return { ...wps[wps.length - 1], heading: fb };
}

function MapPage() {
	const { lang } = Route.useParams();
	const l = lang as Lang;
	const mapRef = useRef<HTMLDivElement>(null);
	const leafletMap = useRef<L.Map | null>(null);
	const markersRef = useRef<Map<string, L.Marker>>(new Map());
	const vehiclesRef = useRef<Vehicle[]>([]);
	const timeDeltaRef = useRef(0);
	const animRef = useRef<number | null>(null);
	const [vehicleCount, setVehicleCount] = useState(0);
	const [loading, setLoading] = useState(true);
	const [filter, setFilter] = useState(1023);
	const [lastUpdate, setLastUpdate] = useState<Date | null>(null);
	const [countdown, setCountdown] = useState(POLL_INTERVAL / 1000);
	const lastFetchRef = useRef(Date.now());
	const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
	const zoomRef = useRef(13);

	const load = useCallback(async () => {
		if (!leafletMap.current) return;
		const bounds = leafletMap.current.getBounds();
		const sw = bounds.getSouthWest();
		const ne = bounds.getNorthEast();
		try {
			const { vehicles, serverTime } = await fetchVehicles({
				data: {
					swLat: sw.lat,
					swLon: sw.lng,
					neLat: ne.lat,
					neLon: ne.lng,
					products: filter,
				},
			});
			timeDeltaRef.current = serverTime - Date.now();
			const now = Date.now() + timeDeltaRef.current;
			const prev = new Map(vehiclesRef.current.map((v) => [v.id, v]));
			for (const v of vehicles) {
				const old = prev.get(v.id);
				if (old && old.waypoints.length >= 2 && v.waypoints.length >= 2) {
					const cur = interpolateVehicle(old, now);
					v.waypoints[0] = { ...v.waypoints[0], lat: cur.lat, lon: cur.lon };
				}
			}
			vehiclesRef.current = vehicles;
			setVehicleCount(vehicles.length);
			setLastUpdate(new Date());
			lastFetchRef.current = Date.now();
			setCountdown(POLL_INTERVAL / 1000);

			const map = leafletMap.current;
			if (!map) return;
			const L = await import("leaflet");
			const existing = markersRef.current;
			const seen = new Set<string>();
			const zoom = map.getZoom();
			const size = getIconSize(zoom);
			const showLabel = zoom >= 15;

			for (const v of vehicles) {
				seen.add(v.id);
				const pos = interpolateVehicle(v, Date.now() + timeDeltaRef.current);

				const icon = L.divIcon({
					html: buildVehicleIcon(
						{ ...v, heading: pos.heading },
						size,
						showLabel,
					),
					iconSize: [size, size],
					iconAnchor: [size / 2, size / 2],
					className: "",
				});

				let marker = existing.get(v.id);
				if (marker) {
					marker.setLatLng([pos.lat, pos.lon]);
					marker.setIcon(icon);
				} else {
					marker = L.marker([pos.lat, pos.lon], { icon }).addTo(map);
					existing.set(v.id, marker);
				}

				marker.unbindTooltip();
				marker.bindTooltip(
					`<strong>${v.name}</strong><br/>→ ${v.direction}${v.operator ? `<br/><span style="opacity:.7">${v.operator}</span>` : ""}`,
					{ direction: "top", offset: [0, -(size / 2 + 4)] },
				);
			}

			for (const [id, marker] of existing) {
				if (!seen.has(id)) {
					marker.remove();
					existing.delete(id);
				}
			}
		} catch {
			/* network error, keep stale data */
		}
		setLoading(false);
	}, [filter]);

	useEffect(() => {
		if (!mapRef.current || leafletMap.current) return;

		let cancelled = false;

		(async () => {
			const L = await import("leaflet");
			if (cancelled) return;

			await import("leaflet-fullscreen");

			const map = L.map(mapRef.current!, {
				center: [FRANKFURT_CENTER.lat, FRANKFURT_CENTER.lon],
				zoom: 13,
				zoomControl: false,
				fullscreenControl: { position: "topright" },
			});

			L.control.zoom({ position: "topright" }).addTo(map);

			L.tileLayer("https://tileserver.memomaps.de/tilegen/{z}/{x}/{y}.png", {
				maxZoom: 18,
				attribution:
					'Map © <a href="https://memomaps.de/">MeMoMaps</a> · Data © <a href="https://www.openstreetmap.org/copyright">OSM</a>',
			}).addTo(map);

			leafletMap.current = map;
			zoomRef.current = map.getZoom();

			map.on("moveend", () => {
				load();
			});

			map.on("zoomend", () => {
				zoomRef.current = map.getZoom();
			});

			load();
		})();

		return () => {
			cancelled = true;
		};
	}, [load]);

	useEffect(() => {
		if (intervalRef.current) clearInterval(intervalRef.current);
		intervalRef.current = setInterval(load, POLL_INTERVAL);
		load();
		return () => {
			if (intervalRef.current) clearInterval(intervalRef.current);
		};
	}, [load]);

	useEffect(() => {
		const animate = () => {
			const now = Date.now() + timeDeltaRef.current;
			const existing = markersRef.current;
			for (const v of vehiclesRef.current) {
				const marker = existing.get(v.id);
				if (!marker || v.waypoints.length < 2) continue;
				const pos = interpolateVehicle(v, now);
				marker.setLatLng([pos.lat, pos.lon]);
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

	return (
		<div className="fixed inset-0 flex flex-col">
			<link
				rel="stylesheet"
				href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"
			/>
			<link
				rel="stylesheet"
				href="https://unpkg.com/leaflet-fullscreen@1.0.2/dist/leaflet.fullscreen.css"
			/>
			<div className="flex items-center gap-2 px-3 py-2 bg-surface border-b border-border z-[1000] overflow-x-auto shrink-0">
				<Link
					to="/$lang"
					params={{ lang: l }}
					className="text-sm font-semibold text-fg no-underline hover:text-accent shrink-0"
				>
					← DummRum
				</Link>
				<span className="text-border">|</span>
				{CATEGORY_FILTERS.map((f) => (
					<button
						key={f.key}
						type="button"
						onClick={() => setFilter(f.bit)}
						className={`px-2 py-0.5 text-xs font-medium rounded-full border cursor-pointer transition-colors shrink-0 ${
							filter === f.bit
								? "bg-surface-hover text-fg border-border"
								: "bg-transparent text-muted border-transparent hover:text-fg"
						}`}
					>
						{f.key !== "all" && (
							<span
								className="inline-block w-2 h-2 rounded-full mr-1 align-middle"
								style={{
									backgroundColor:
										CATEGORY_COLORS[f.key] ?? CATEGORY_COLORS.Other,
								}}
							/>
						)}
						{f.label}
					</button>
				))}
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

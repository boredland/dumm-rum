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
	256: "Ferry",
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
						};
						jnyL?: {
							jid: string;
							pos: { x: number; y: number };
							dirTxt?: string;
							dirGeo?: number;
							prodX?: number;
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
			const jnyL = svc.res.jnyL ?? [];

			const decodedPolys = new Map<number, [number, number][]>();

			const vehicles: Vehicle[] = jnyL.map((j) => {
				const prod = j.prodX != null ? prodL[j.prodX] : undefined;
				const oprIdx = prod?.oprX;
				const icoIdx = prod?.icoX;
				const ico =
					icoIdx != null && icoIdx < icoL.length ? icoL[icoIdx] : undefined;

				const bg = ico?.bg ? rgbToHex(ico.bg.r, ico.bg.g, ico.bg.b) : "#666";
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

				return {
					id: j.jid,
					name: prod?.name?.trim() ?? "?",
					lat: j.pos.y / 1_000_000,
					lon: j.pos.x / 1_000_000,
					direction: j.dirTxt ?? "",
					heading: j.dirGeo ?? 0,
					category: classifyProduct(prod?.cls ?? 0),
					operator: oprIdx != null ? (opL[oprIdx]?.name ?? "") : "",
					icoRes: ico?.res ?? "PROD_GEN",
					bg,
					fg,
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

const ICON_PATHS: Record<string, string> = {
	PROD_BUS:
		"M20 14a6 6 0 0 0-6-6h-4a6 6 0 0 0-6 6v8a2 2 0 0 0 2 2h1l1 2h2l1-2h2l1 2h2l1-2h1a2 2 0 0 0 2-2v-8zm-12-3h8a3 3 0 0 1 3 3v3H8v-3a3 3 0 0 1 3-3h-3zm-1 11a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zm10 0a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3z",
	PROD_TRAM:
		"M17 4H7a4 4 0 0 0-4 4v10a3 3 0 0 0 3 3l-1 2h2l1-2h8l1 2h2l-1-2a3 3 0 0 0 3-3V8a4 4 0 0 0-4-4zM7 6h10a2 2 0 0 1 2 2v5H5V8a2 2 0 0 1 2-2zm1 14a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zm8 0a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3z",
	PROD_REG:
		"M17.5 3h-11A3.5 3.5 0 0 0 3 6.5V18a2 2 0 0 0 2 2l-1 2h2l2-2h8l2 2h2l-1-2a2 2 0 0 0 2-2V6.5A3.5 3.5 0 0 0 17.5 3zM7 5h10a1.5 1.5 0 0 1 1.5 1.5V11h-13V6.5A1.5 1.5 0 0 1 7 5zm0.5 15a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zm9 0a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3z",
	PROD_ICE:
		"M17.5 3h-11A3.5 3.5 0 0 0 3 6.5V18a2 2 0 0 0 2 2l-1 2h2l2-2h8l2 2h2l-1-2a2 2 0 0 0 2-2V6.5A3.5 3.5 0 0 0 17.5 3zM7 5h10a1.5 1.5 0 0 1 1.5 1.5V11h-13V6.5A1.5 1.5 0 0 1 7 5zm0.5 15a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zm9 0a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3z",
	PROD_IC:
		"M17.5 3h-11A3.5 3.5 0 0 0 3 6.5V18a2 2 0 0 0 2 2l-1 2h2l2-2h8l2 2h2l-1-2a2 2 0 0 0 2-2V6.5A3.5 3.5 0 0 0 17.5 3zM7 5h10a1.5 1.5 0 0 1 1.5 1.5V11h-13V6.5A1.5 1.5 0 0 1 7 5zm0.5 15a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zm9 0a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3z",
};

const ICON_LETTERS: Record<string, string> = {
	PROD_COMM_T: "S",
	PROD_SUB_T: "U",
};

const ICON_SIZE_BY_ZOOM = [
	20, 20, 20, 20, 20, 20, 20, 20, 20, 20, 22, 26, 30, 34, 38, 42, 48, 52, 56,
];

function getIconSize(zoom: number): number {
	return ICON_SIZE_BY_ZOOM[Math.min(zoom, ICON_SIZE_BY_ZOOM.length - 1)] ?? 30;
}

function buildVehicleIcon(
	v: Vehicle,
	size: number,
	showLabel: boolean,
): string {
	const r = size / 2;
	const arrowSize = size + 10;
	const arrowR = arrowSize / 2;
	const headingDeg = v.heading >= 0 ? v.heading * 11.25 : 0;

	const letterKey = Object.keys(ICON_LETTERS).find((k) =>
		v.icoRes.includes(k.replace("PROD_", "")),
	);
	const pathKey = Object.keys(ICON_PATHS).find((k) =>
		v.icoRes.includes(k.replace("PROD_", "")),
	);

	let iconContent: string;
	if (letterKey) {
		const letter = ICON_LETTERS[letterKey];
		iconContent = `<text x="12" y="17.5" text-anchor="middle" font-size="16" font-weight="bold" fill="${v.fg}" font-family="system-ui,sans-serif">${letter}</text>`;
	} else if (pathKey) {
		iconContent = `<g transform="scale(${size / 48})"><path d="${ICON_PATHS[pathKey]}" fill="${v.fg}"/></g>`;
	} else {
		iconContent = `<circle cx="12" cy="12" r="6" fill="${v.fg}"/>`;
	}

	const arrow =
		v.heading >= 0
			? `<polygon points="${arrowR + arrowR * 0.7},${arrowR} ${arrowR + arrowR * 0.35},${arrowR - arrowR * 0.3} ${arrowR + arrowR * 0.35},${arrowR + arrowR * 0.3}" fill="${v.bg}" stroke="#fff" stroke-width="1.5" transform="rotate(${headingDeg},${arrowR},${arrowR})"/>`
			: "";

	const label = showLabel
		? `<div style="position:absolute;top:${arrowSize}px;left:50%;transform:translateX(-50%);white-space:nowrap;background:${v.bg};color:${v.fg};font-size:10px;font-weight:600;padding:1px 4px;border-radius:3px;line-height:1.3;font-family:system-ui,sans-serif;border:1px solid rgba(255,255,255,.6)">${v.name}</div>`
		: "";

	return `<div style="position:relative;width:${arrowSize}px;height:${arrowSize}px">
<svg width="${arrowSize}" height="${arrowSize}" viewBox="0 0 ${arrowSize} ${arrowSize}">
${arrow}
<circle cx="${arrowR}" cy="${arrowR}" r="${r * 0.92}" fill="#fff"/>
<circle cx="${arrowR}" cy="${arrowR}" r="${r * 0.8}" fill="${v.bg}"/>
<svg x="${arrowR - 12}" y="${arrowR - 12}" width="24" height="24" viewBox="0 0 24 24">${iconContent}</svg>
</svg>${label}</div>`;
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
	if (wps.length < 2) return { lat: v.lat, lon: v.lon, heading: v.heading };

	if (now <= wps[0].t) return wps[0];
	if (now >= wps[wps.length - 1].t) return wps[wps.length - 1];

	for (let i = 0; i < wps.length - 1; i++) {
		if (now >= wps[i].t && now < wps[i + 1].t) {
			const ratio = (now - wps[i].t) / (wps[i + 1].t - wps[i].t);
			return {
				lat: wps[i].lat + ratio * (wps[i + 1].lat - wps[i].lat),
				lon: wps[i].lon + ratio * (wps[i + 1].lon - wps[i].lon),
				heading: wps[i + 1].heading >= 0 ? wps[i + 1].heading : wps[i].heading,
			};
		}
	}
	return wps[wps.length - 1];
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
			vehiclesRef.current = vehicles;
			setVehicleCount(vehicles.length);
			setLastUpdate(new Date());

			const map = leafletMap.current;
			if (!map) return;
			const L = await import("leaflet");
			const existing = markersRef.current;
			const seen = new Set<string>();
			const zoom = map.getZoom();
			const size = getIconSize(zoom);
			const showLabel = zoom >= 15;
			const arrowSize = size + 10;

			for (const v of vehicles) {
				seen.add(v.id);
				const pos = interpolateVehicle(v, Date.now() + timeDeltaRef.current);

				let marker = existing.get(v.id);
				if (marker) {
					marker.setLatLng([pos.lat, pos.lon]);
					marker.setIcon(
						L.divIcon({
							html: buildVehicleIcon(
								{ ...v, heading: pos.heading },
								size,
								showLabel,
							),
							iconSize: [arrowSize, arrowSize],
							iconAnchor: [arrowSize / 2, arrowSize / 2],
							className: "",
						}),
					);
				} else {
					marker = L.marker([pos.lat, pos.lon], {
						icon: L.divIcon({
							html: buildVehicleIcon(
								{ ...v, heading: pos.heading },
								size,
								showLabel,
							),
							iconSize: [arrowSize, arrowSize],
							iconAnchor: [arrowSize / 2, arrowSize / 2],
							className: "",
						}),
					}).addTo(map);
					existing.set(v.id, marker);
				}

				marker.unbindTooltip();
				marker.bindTooltip(
					`<strong>${v.name}</strong><br/>→ ${v.direction}${v.operator ? `<br/><span style="opacity:.7">${v.operator}</span>` : ""}`,
					{ direction: "top", offset: [0, -(arrowSize / 2 + 4)] },
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
				<span className="ml-auto text-xs text-dimmed tabular-nums shrink-0">
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
				</span>
			</div>
			<div ref={mapRef} className="flex-1" />
		</div>
	);
}

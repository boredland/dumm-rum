import { createFileRoute, Link } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Lang } from "../../../lib/i18n.ts";

const MGATE_URL = "https://www.rmv.de/auskunft/bin/jp/mgate.exe";
const AUTH = { type: "AID", aid: "uAWgheC24jhp6GdY" };
const CLIENT = { id: "RMV", type: "WEB", name: "webapp", l: "vs_rmv" };

const FRANKFURT_CENTER = { lat: 50.1109, lon: 8.6821 };
const DEFAULT_RADIUS = 15000;
const POLL_INTERVAL = 30_000;

interface Vehicle {
	id: string;
	name: string;
	lat: number;
	lon: number;
	direction: string;
	heading: number;
	progress: number;
	category: string;
	operator: string;
	status: string | null;
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

const fetchVehicles = createServerFn({ method: "GET" })
	.inputValidator(
		(
			input: unknown,
		): { lat: number; lon: number; radius: number; products: number } => {
			const o = input as Record<string, unknown>;
			return {
				lat: Number(o.lat) || FRANKFURT_CENTER.lat,
				lon: Number(o.lon) || FRANKFURT_CENTER.lon,
				radius: Math.min(Number(o.radius) || DEFAULT_RADIUS, 50000),
				products: Number(o.products) || 1023,
			};
		},
	)
	.handler(async ({ data }): Promise<Vehicle[]> => {
		const now = new Date();
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
						ring: {
							cCrd: {
								x: Math.round(data.lon * 1_000_000),
								y: Math.round(data.lat * 1_000_000),
							},
							maxDist: data.radius,
						},
						perSize: 60000,
						perStep: 60000,
						ageOfReport: true,
						jnyFltrL: [
							{ type: "PROD", mode: "INC", value: String(data.products) },
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

		if (!resp.ok) return [];

		const json = (await resp.json()) as {
			svcResL?: {
				meth: string;
				err?: string;
				res?: {
					common?: {
						prodL?: {
							name?: string;
							nameS?: string;
							cls?: number;
							oprX?: number;
						}[];
						opL?: { name: string }[];
					};
					jnyL?: {
						jid: string;
						pos: { x: number; y: number };
						dirTxt?: string;
						dirGeo?: number;
						proc?: number;
						prodX?: number;
						status?: string;
					}[];
				};
			}[];
		};

		const svc = json.svcResL?.[0];
		if (!svc?.res) return [];

		const prodL = svc.res.common?.prodL ?? [];
		const opL = svc.res.common?.opL ?? [];
		const jnyL = svc.res.jnyL ?? [];

		return jnyL.map((j) => {
			const prod = j.prodX != null ? prodL[j.prodX] : undefined;
			const oprIdx = (prod as { oprX?: number } | undefined)?.oprX;
			return {
				id: j.jid,
				name: prod?.name?.trim() ?? "?",
				lat: j.pos.y / 1_000_000,
				lon: j.pos.x / 1_000_000,
				direction: j.dirTxt ?? "",
				heading: j.dirGeo ?? 0,
				progress: j.proc ?? 0,
				category: classifyProduct(prod?.cls ?? 0),
				operator: oprIdx != null ? (opL[oprIdx]?.name ?? "") : "",
				status: j.status ?? null,
			};
		});
	});

export const Route = createFileRoute("/$lang/map/")({
	head: () => ({
		meta: [{ title: "DummRum — Live Map" }],
	}),
	component: MapPage,
});

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

const CATEGORY_FILTERS = [
	{ key: "all", label: "All", bit: 1023 },
	{ key: "ICE", label: "ICE/IC", bit: 3 },
	{ key: "RE/RB", label: "RE/RB", bit: 4 },
	{ key: "S-Bahn", label: "S-Bahn", bit: 8 },
	{ key: "U-Bahn", label: "U-Bahn", bit: 16 },
	{ key: "Tram", label: "Tram", bit: 32 },
	{ key: "Bus", label: "Bus", bit: 192 },
] as const;

function MapPage() {
	const { lang } = Route.useParams();
	const l = lang as Lang;
	const mapRef = useRef<HTMLDivElement>(null);
	const leafletMap = useRef<L.Map | null>(null);
	const markersRef = useRef<Map<string, L.CircleMarker>>(new Map());
	const [vehicles, setVehicles] = useState<Vehicle[]>([]);
	const [loading, setLoading] = useState(true);
	const [filter, setFilter] = useState(1023);
	const [lastUpdate, setLastUpdate] = useState<Date | null>(null);
	const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

	const load = useCallback(async () => {
		if (!leafletMap.current) return;
		const center = leafletMap.current.getCenter();
		const bounds = leafletMap.current.getBounds();
		const ne = bounds.getNorthEast();
		const radius = Math.round(center.distanceTo(ne));
		try {
			const data = await fetchVehicles({
				data: {
					lat: center.lat,
					lon: center.lng,
					radius: Math.min(radius, 50000),
					products: filter,
				},
			});
			setVehicles(data);
			setLastUpdate(new Date());
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

			const map = L.map(mapRef.current!, {
				center: [FRANKFURT_CENTER.lat, FRANKFURT_CENTER.lon],
				zoom: 13,
				zoomControl: false,
			});

			L.control.zoom({ position: "topright" }).addTo(map);

			L.tileLayer("https://tileserver.memomaps.de/tilegen/{z}/{x}/{y}.png", {
				maxZoom: 18,
				attribution:
					'Map © <a href="https://memomaps.de/">MeMoMaps</a> · Data © <a href="https://www.openstreetmap.org/copyright">OSM</a>',
			}).addTo(map);

			leafletMap.current = map;

			map.on("moveend", () => {
				load();
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
		if (!leafletMap.current) return;

		let L: typeof import("leaflet") | null = null;

		(async () => {
			L = await import("leaflet");
			const map = leafletMap.current!;
			const existing = markersRef.current;
			const seen = new Set<string>();

			for (const v of vehicles) {
				seen.add(v.id);
				const color = CATEGORY_COLORS[v.category] ?? CATEGORY_COLORS.Other;
				const pos: [number, number] = [v.lat, v.lon];

				let marker = existing.get(v.id);
				if (marker) {
					marker.setLatLng(pos);
					marker.setStyle({ color, fillColor: color });
				} else {
					marker = L.circleMarker(pos, {
						radius: 6,
						color,
						fillColor: color,
						fillOpacity: 0.9,
						weight: 2,
					}).addTo(map);
					existing.set(v.id, marker);
				}

				marker.unbindTooltip();
				marker.bindTooltip(
					`<strong>${v.name}</strong><br/>→ ${v.direction}${v.operator ? `<br/><span style="opacity:.7">${v.operator}</span>` : ""}`,
					{ direction: "top", offset: [0, -8] },
				);
			}

			for (const [id, marker] of existing) {
				if (!seen.has(id)) {
					marker.remove();
					existing.delete(id);
				}
			}
		})();
	}, [vehicles]);

	return (
		<div className="fixed inset-0 flex flex-col">
			<link
				rel="stylesheet"
				href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"
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
					{loading ? "…" : `${vehicles.length} vehicles`}
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

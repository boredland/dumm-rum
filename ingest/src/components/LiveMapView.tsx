import "leaflet/dist/leaflet.css";
import "leaflet.fullscreen/dist/Control.FullScreen.css";

import type {
	DivIcon,
	Map as LeafletMap,
	Marker,
	Polyline,
	TileLayer,
} from "leaflet";
import { useEffect, useRef, useState } from "react";
import type { Lang } from "../lib/i18n.ts";
import type { LiveMapPayload, MapVehicle } from "../lib/liveMap.ts";

interface Props {
	initial: LiveMapPayload;
	lang: Lang;
	texts: {
		vehicles: string;
		noVehicles: string;
		lastUpdate: string;
		filterAll: string;
	};
	refreshMs?: number;
	onRefresh: () => Promise<LiveMapPayload>;
}

type FilterKey = "all" | "U-Bahn" | "S" | "Tram" | "Bus" | "RE,RB";

const FILTERS: { key: FilterKey; label: string }[] = [
	{ key: "all", label: "" }, // label injected at render time from i18n
	{ key: "U-Bahn", label: "U-Bahn" },
	{ key: "S", label: "S-Bahn" },
	{ key: "Tram", label: "Tram" },
	{ key: "Bus", label: "Bus" },
	{ key: "RE,RB", label: "RE/RB" },
];

const CATEGORY_ICON_URLS: Record<string, string> = {
	"U-Bahn": "/icons/ubahn.svg",
	"S-Bahn": "/icons/sbahn.svg",
	Tram: "/icons/tram.svg",
	Bus: "/icons/bus.svg",
	RE: "/icons/reg.svg",
	RB: "/icons/reg.svg",
};

function normalizeCategory(cat: string | null): string {
	if (!cat) return "Bus";
	if (cat === "S") return "S-Bahn";
	if (/bus$/i.test(cat) || cat === "AST") return "Bus";
	if (/stra(ß|ss)enbahn$/i.test(cat)) return "Tram";
	return cat;
}

function matchesFilter(cat: string | null, filter: FilterKey): boolean {
	if (filter === "all") return true;
	const n = normalizeCategory(cat);
	if (filter === "RE,RB") return n === "RE" || n === "RB";
	if (filter === "S") return n === "S-Bahn";
	return n === filter;
}

function timeToSeconds(hms: string | null): number | null {
	if (!hms) return null;
	const m = /^(\d{2}):(\d{2}):(\d{2})/.exec(hms);
	if (!m) return null;
	return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

function secondsNow(): number {
	const d = new Date();
	return d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds();
}

function delayMinForVehicle(v: MapVehicle): number {
	if (!v.reportedAt) return 0;
	// Without access to planned arrival timestamps per stop we can't compute
	// a true delay here — left at 0 for now. (Astro version did the same
	// for the marker icon path; full delay tracking lives on the stop row.)
	return 0;
}

function createIcon(
	L: typeof import("leaflet"),
	cat: string | null,
	sleeping: boolean,
	ghost: boolean,
	delayMin: number,
): DivIcon {
	const iconUrl =
		CATEGORY_ICON_URLS[normalizeCategory(cat)] ?? CATEGORY_ICON_URLS.Bus;
	const opacity = sleeping ? "opacity:0.5;" : "";
	const shimmer = ghost
		? "animation:ghost-shimmer 2s ease-in-out infinite;"
		: "";
	const badge =
		!ghost && sleeping
			? `<span style="position:absolute;top:-8px;right:-6px;font-size:10px;line-height:1">💤</span>`
			: !ghost && delayMin >= 8
				? `<span style="position:absolute;top:-6px;right:-6px;font-size:9px;line-height:1;background:#cf222e;color:white;border-radius:4px;padding:1px 3px;font-weight:bold">+${delayMin}</span>`
				: "";
	const border =
		!ghost && delayMin >= 8
			? "outline:2px solid #cf222e;outline-offset:1px;"
			: "";
	return L.divIcon({
		className: "",
		html: `<div style="position:relative;${opacity}${shimmer}"><img src="${iconUrl}" width="30" height="30" style="border-radius:50%;box-shadow:0 2px 6px rgba(0,0,0,.35);${border}" />${badge}</div>`,
		iconSize: [30, 30],
		iconAnchor: [15, 15],
		popupAnchor: [0, -17],
		tooltipAnchor: [0, -17],
	});
}

interface VehicleMarker {
	marker: Marker;
	polyline: Polyline | null;
	iconKey: string;
}

export function LiveMapView({
	initial,
	lang,
	texts,
	refreshMs = 30_000,
	onRefresh,
}: Props) {
	const [payload, setPayload] = useState(initial);
	const [filter, setFilter] = useState<FilterKey>("all");
	const mapElRef = useRef<HTMLDivElement | null>(null);
	const mapRef = useRef<LeafletMap | null>(null);
	const leafletRef = useRef<typeof import("leaflet") | null>(null);
	const markersRef = useRef<Map<string, VehicleMarker>>(new Map());

	// Initialize leaflet once, client-side only.
	useEffect(() => {
		let cancelled = false;

		const darkMql = window.matchMedia("(prefers-color-scheme: dark)");
		const lightTile = {
			url: "https://tile.memomaps.de/tilegen/{z}/{x}/{y}.png",
			attribution:
				'&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &middot; <a href="https://memomaps.de/">memomaps.de</a>',
			maxZoom: 18,
		};
		const darkTile = {
			url: "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",
			attribution:
				'&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &middot; <a href="https://carto.com/attributions">CARTO</a>',
			maxZoom: 19,
		};
		const themedTile = () => (darkMql.matches ? darkTile : lightTile);

		(async () => {
			const L = (await import("leaflet")).default;
			await import("leaflet.fullscreen");
			if (cancelled || !mapElRef.current) return;
			leafletRef.current = L;

			const map = L.map(mapElRef.current, { zoomControl: true }).setView(
				[50.11, 8.68],
				12,
			);
			// biome-ignore lint/suspicious/noExplicitAny: fullscreen plugin augments L.control
			const fs = (L.control as any).fullscreen;
			if (fs) fs({ position: "topleft" }).addTo(map);

			let currentTileLayer: TileLayer = L.tileLayer(
				themedTile().url,
				themedTile(),
			);
			currentTileLayer.addTo(map);

			const osmFallback = L.tileLayer(
				"https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
				{
					attribution:
						'&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
					maxZoom: 19,
				},
			);
			currentTileLayer.on("tileerror", () => {
				if (!map.hasLayer(osmFallback)) {
					currentTileLayer.remove();
					osmFallback.addTo(map);
				}
			});

			const onThemeChange = () => {
				currentTileLayer.remove();
				currentTileLayer = L.tileLayer(themedTile().url, themedTile());
				currentTileLayer.addTo(map);
			};
			darkMql.addEventListener("change", onThemeChange);
			mapRef.current = map;

			// Expose cleanup for the outer effect teardown.
			(map as unknown as { _themeCleanup?: () => void })._themeCleanup = () =>
				darkMql.removeEventListener("change", onThemeChange);
		})();

		return () => {
			cancelled = true;
			if (mapRef.current) {
				(
					mapRef.current as unknown as { _themeCleanup?: () => void }
				)._themeCleanup?.();
				mapRef.current.remove();
				mapRef.current = null;
			}
			markersRef.current.clear();
		};
	}, []);

	// Redraw markers whenever payload or filter changes.
	useEffect(() => {
		const L = leafletRef.current;
		const map = mapRef.current;
		if (!L || !map) return;

		const nowSec = secondsNow();
		const existing = markersRef.current;
		const seen = new Set<string>();

		for (const v of payload.vehicles) {
			const isGhost = v.ghost === 1;
			const visible = matchesFilter(v.category, filter);
			const depSec = timeToSeconds(v.originDepTime);
			const sleeping = !isGhost && depSec !== null && depSec > nowSec + 300;
			const delayMin = delayMinForVehicle(v);

			if (isGhost) {
				// Ghosts have no GPS — render at the stop currently expected.
				const stops = v.stops ? JSON.parse(v.stops) : [];
				const now = nowSec;
				let ghostStop = stops[0];
				for (const s of stops) {
					const depTime = timeToSeconds(s.dep ?? s.arr);
					if (depTime !== null && depTime <= now) ghostStop = s;
				}
				if (!ghostStop?.lat || !ghostStop?.lon || !visible) {
					const prev = existing.get(v.id);
					if (prev) {
						prev.marker.remove();
						prev.polyline?.remove();
						existing.delete(v.id);
					}
					continue;
				}
				seen.add(v.id);
				const iconKey = `${v.category}:ghost`;
				let entry = existing.get(v.id);
				if (!entry) {
					const icon = createIcon(L, v.category, false, true, 0);
					const marker = L.marker([ghostStop.lat, ghostStop.lon], { icon });
					marker.bindTooltip(`👻 ${v.line} → ${v.destination}`, {
						direction: "top",
					});
					marker.addTo(map);
					entry = { marker, polyline: null, iconKey };
					existing.set(v.id, entry);
				} else {
					entry.marker.setLatLng([ghostStop.lat, ghostStop.lon]);
					if (entry.iconKey !== iconKey) {
						entry.marker.setIcon(createIcon(L, v.category, false, true, 0));
						entry.iconKey = iconKey;
					}
				}
				continue;
			}

			if (!visible || v.lat === null || v.lon === null) {
				const prev = existing.get(v.id);
				if (prev) {
					prev.marker.remove();
					prev.polyline?.remove();
					existing.delete(v.id);
				}
				continue;
			}

			seen.add(v.id);
			const iconKey = sleeping
				? `${v.category}:zzz`
				: delayMin >= 8
					? `${v.category}:delay:${delayMin}`
					: `${v.category}`;

			let entry = existing.get(v.id);
			if (!entry) {
				const icon = createIcon(L, v.category, sleeping, false, delayMin);
				const marker = L.marker([v.lat, v.lon], { icon });
				marker.bindTooltip(`${v.line} → ${v.destination}`, {
					direction: "top",
				});
				marker.addTo(map);
				entry = { marker, polyline: null, iconKey };
				existing.set(v.id, entry);
			} else {
				entry.marker.setLatLng([v.lat, v.lon]);
				if (entry.iconKey !== iconKey) {
					entry.marker.setIcon(
						createIcon(L, v.category, sleeping, false, delayMin),
					);
					entry.iconKey = iconKey;
				}
			}
		}

		// Remove markers for vehicles that disappeared from the payload.
		for (const [id, entry] of existing.entries()) {
			if (!seen.has(id)) {
				entry.marker.remove();
				entry.polyline?.remove();
				existing.delete(id);
			}
		}
	}, [payload, filter]);

	// Poll for updates.
	useEffect(() => {
		if (refreshMs <= 0) return;
		const tick = async () => {
			try {
				const next = await onRefresh();
				setPayload(next);
			} catch (e) {
				console.error("map refresh failed", e);
			}
		};
		const id = setInterval(tick, refreshMs);
		return () => clearInterval(id);
	}, [onRefresh, refreshMs]);

	const visibleCount = payload.vehicles.filter(
		(v) =>
			matchesFilter(v.category, filter) && (v.ghost === 1 || v.lat !== null),
	).length;

	const lastUpdate = new Date(payload.updatedAt).toLocaleTimeString(lang, {
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
	});

	return (
		<>
			<style>{`@keyframes ghost-shimmer { 0%, 100% { opacity: 0.3; } 50% { opacity: 0.8; } }`}</style>

			<div
				style={{
					display: "flex",
					justifyContent: "space-between",
					marginBottom: "0.75rem",
					fontSize: "0.875rem",
				}}
			>
				<span>
					{visibleCount} {texts.vehicles}
					{visibleCount === 0 ? ` — ${texts.noVehicles}` : ""}
				</span>
				<span style={{ color: "var(--dimmed)" }}>
					{texts.lastUpdate}: {lastUpdate}
				</span>
			</div>

			<div
				ref={mapElRef}
				style={{
					height: "calc(100dvh - 200px)",
					minHeight: 400,
					borderRadius: 8,
					border: "1px solid var(--border)",
					overflow: "hidden",
				}}
			/>

			<div
				style={{
					marginTop: "0.75rem",
					display: "flex",
					flexWrap: "wrap",
					gap: "0.5rem",
				}}
			>
				{FILTERS.map((f) => (
					<button
						key={f.key}
						type="button"
						onClick={() => setFilter(f.key)}
						style={{
							padding: "0.25rem 0.625rem",
							fontSize: "0.75rem",
							fontWeight: 500,
							borderRadius: 9999,
							border: "1px solid var(--border)",
							cursor: "pointer",
							background:
								filter === f.key ? "var(--surface-hover)" : "transparent",
							color: filter === f.key ? "var(--fg)" : "var(--muted)",
						}}
					>
						{f.key === "all" ? texts.filterAll : f.label}
					</button>
				))}
			</div>
		</>
	);
}

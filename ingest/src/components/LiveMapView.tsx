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
import {
	computeTarget,
	easeMarkerTo,
	secondsNow as motionSecondsNow,
	upsertVehicleState,
	type VehicleState,
} from "../lib/mapMotion.ts";

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

function delayMinForVehicle(v: MapVehicle): number {
	return v.delayMin ?? 0;
}

function escapeHtml(s: string): string {
	return s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

function popupHtml(v: MapVehicle, lang: Lang): string {
	const labels =
		lang === "de"
			? { from: "Von", to: "Nach", delay: "Verspätung" }
			: { from: "From", to: "To", delay: "Delay" };
	const delay =
		v.delayMin > 0
			? `<div style="color:#cf222e;font-weight:600;margin-top:4px">+${v.delayMin} min ${escapeHtml(labels.delay)}</div>`
			: "";
	const schedStart = v.originDepTime?.slice(0, 5) ?? "";
	const schedEnd = v.destArrTime?.slice(0, 5) ?? "";
	const ghostMark = v.ghost === 1 ? "👻 " : "";
	return `
		<div style="min-width:200px;line-height:1.4">
			<div style="font-weight:600;font-size:0.95rem">${ghostMark}${escapeHtml(v.line)} → ${escapeHtml(v.destination)}</div>
			<div style="color:var(--muted);font-size:0.8125rem;margin-top:6px">
				<div><strong>${escapeHtml(labels.from)}:</strong> ${escapeHtml(v.origin)} ${schedStart ? `<span style="opacity:.7">(${schedStart})</span>` : ""}</div>
				<div><strong>${escapeHtml(labels.to)}:</strong> ${escapeHtml(v.destination)} ${schedEnd ? `<span style="opacity:.7">(${schedEnd})</span>` : ""}</div>
			</div>
			${delay}
		</div>
	`;
}

function attachPopup(
	L: typeof import("leaflet"),
	map: LeafletMap,
	entry: VehicleMarker,
	v: MapVehicle,
	lang: Lang,
): void {
	entry.marker.bindPopup(popupHtml(v, lang));
	entry.marker.on("popupopen", () => {
		if (!v.polyline) return;
		try {
			const pts = JSON.parse(v.polyline) as [number, number][];
			if (pts.length < 2) return;
			if (entry.polyline) entry.polyline.remove();
			entry.polyline = L.polyline(pts, {
				color: "#0969da",
				weight: 4,
				opacity: 0.75,
				className: "journey-polyline",
			});
			entry.polyline.addTo(map);
		} catch {
			/* malformed polyline JSON — skip */
		}
	});
	entry.marker.on("popupclose", () => {
		entry.polyline?.remove();
		entry.polyline = null;
	});
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
	const [mapReady, setMapReady] = useState(false);
	const mapElRef = useRef<HTMLDivElement | null>(null);
	const mapRef = useRef<LeafletMap | null>(null);
	const leafletRef = useRef<typeof import("leaflet") | null>(null);
	const markersRef = useRef<Map<string, VehicleMarker>>(new Map());
	// Per-vehicle motion state (GPS history, polyline, resolved stops) drives
	// the requestAnimationFrame loop that positions markers smoothly between
	// the 30s polls.
	const vehicleStatesRef = useRef<Map<string, VehicleState>>(new Map());
	// Keep current filter in a ref so the map's moveend/zoomend callbacks
	// can read the latest value without closing over a stale render.
	const currentFilterRef = useRef<FilterKey>("all");
	const hashWriterRef = useRef<(() => void) | null>(null);

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

		// Parse `#lat/lng/zoom[/filter]` so refreshing keeps the view.
		const parseHash = (): {
			lat: number;
			lon: number;
			zoom: number;
			filter: FilterKey | null;
		} => {
			const fallback = { lat: 50.11, lon: 8.68, zoom: 12, filter: null };
			const parts = window.location.hash.slice(1).split("/");
			if (parts.length < 3) return fallback;
			const lat = Number(parts[0]);
			const lon = Number(parts[1]);
			const zoom = Number(parts[2]);
			if (
				!Number.isFinite(lat) ||
				!Number.isFinite(lon) ||
				!Number.isFinite(zoom)
			) {
				return fallback;
			}
			const f = parts[3] ? decodeURIComponent(parts[3]) : null;
			const isFilter = (x: string | null): x is FilterKey =>
				!!x && FILTERS.some((entry) => entry.key === x);
			return { lat, lon, zoom, filter: isFilter(f) ? f : null };
		};

		const init = parseHash();
		if (init.filter && init.filter !== "all") setFilter(init.filter);

		(async () => {
			const L = (await import("leaflet")).default;
			const { FullScreen } = await import("leaflet.fullscreen");
			if (cancelled || !mapElRef.current) return;
			leafletRef.current = L;

			const map = L.map(mapElRef.current, { zoomControl: true }).setView(
				[init.lat, init.lon],
				init.zoom,
			);
			new FullScreen({ position: "topleft" }).addTo(map);

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

			const updateHash = () => {
				const c = map.getCenter();
				const z = map.getZoom();
				const f =
					currentFilterRef.current === "all"
						? ""
						: `/${encodeURIComponent(currentFilterRef.current)}`;
				history.replaceState(
					null,
					"",
					`#${c.lat.toFixed(5)}/${c.lng.toFixed(5)}/${z}${f}`,
				);
			};
			map.on("moveend", updateHash);
			map.on("zoomend", updateHash);
			hashWriterRef.current = updateHash;

			mapRef.current = map;

			// Expose cleanup for the outer effect teardown.
			(map as unknown as { _themeCleanup?: () => void })._themeCleanup = () =>
				darkMql.removeEventListener("change", onThemeChange);

			// Triggers the marker-drawing effect so initial vehicles render
			// immediately instead of waiting for the first poll.
			setMapReady(true);
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
			setMapReady(false);
		};
	}, []);

	// Redraw markers whenever payload or filter changes. mapReady flips
	// true once Leaflet finishes its async import — keeping it in deps
	// means the very first payload renders as soon as the map mounts,
	// not 30s later at the first refresh.
	useEffect(() => {
		if (!mapReady) return;
		const L = leafletRef.current;
		const map = mapRef.current;
		if (!L || !map) return;

		const nowSec = Math.floor(motionSecondsNow());
		const existing = markersRef.current;
		const states = vehicleStatesRef.current;
		const seen = new Set<string>();

		for (const v of payload.vehicles) {
			const isGhost = v.ghost === 1;
			const visible = matchesFilter(v.category, filter);
			const depSec = timeToSeconds(v.originDepTime);
			const sleeping = !isGhost && depSec !== null && depSec > nowSec + 300;
			const delayMin = delayMinForVehicle(v);

			// Non-tracked vehicle (no GPS, not a ghost) OR filtered out — evict.
			const untrackable = !isGhost && (v.lat === null || v.lon === null);
			if (!visible || untrackable) {
				const prev = existing.get(v.id);
				if (prev) {
					prev.marker.remove();
					prev.polyline?.remove();
					existing.delete(v.id);
				}
				states.delete(v.id);
				continue;
			}

			// Upsert motion state. Drives the RAF positioning loop.
			const nextState = upsertVehicleState(states.get(v.id), v);
			states.set(v.id, nextState);

			seen.add(v.id);
			const iconKey = isGhost
				? `${v.category}:ghost`
				: sleeping
					? `${v.category}:zzz`
					: delayMin >= 8
						? `${v.category}:delay:${delayMin}`
						: `${v.category}`;

			let entry = existing.get(v.id);
			if (!entry) {
				// Initial position: GPS if known, else first scheduled stop with
				// coordinates. The RAF loop takes over on the next frame.
				const initLat = isGhost
					? (nextState.stops.find((s) => s.lat !== null)?.lat ?? 50.11)
					: (v.lat ?? 50.11);
				const initLon = isGhost
					? (nextState.stops.find((s) => s.lon !== null)?.lon ?? 8.68)
					: (v.lon ?? 8.68);
				const icon = createIcon(
					L,
					v.category,
					sleeping,
					isGhost,
					isGhost ? 0 : delayMin,
				);
				const marker = L.marker([initLat, initLon], { icon });
				marker.bindTooltip(
					`${isGhost ? "👻 " : ""}${v.line} → ${v.destination}`,
					{ direction: "top" },
				);
				marker.addTo(map);
				entry = { marker, polyline: null, iconKey };
				existing.set(v.id, entry);
				attachPopup(L, map, entry, v, lang);
			} else {
				// Don't setLatLng here — the RAF loop handles positioning. Just
				// refresh popup content + icon if they've changed.
				entry.marker.setPopupContent(popupHtml(v, lang));
				if (entry.iconKey !== iconKey) {
					entry.marker.setIcon(
						createIcon(
							L,
							v.category,
							sleeping,
							isGhost,
							isGhost ? 0 : delayMin,
						),
					);
					entry.iconKey = iconKey;
				}
			}
		}

		// Remove markers + state for vehicles that disappeared from the payload.
		for (const [id, entry] of existing.entries()) {
			if (!seen.has(id)) {
				entry.marker.remove();
				entry.polyline?.remove();
				existing.delete(id);
				states.delete(id);
			}
		}
	}, [mapReady, payload, filter, lang]);

	// Motion loop: eased interpolation between GPS fixes + observed-velocity
	// extrapolation along the polyline. Runs once per frame independently of
	// the 30s payload polls; cancels on unmount.
	useEffect(() => {
		if (!mapReady) return;
		let rafId = 0;
		const tick = () => {
			const now = motionSecondsNow();
			const markers = markersRef.current;
			const states = vehicleStatesRef.current;
			for (const [id, entry] of markers) {
				const state = states.get(id);
				if (!state) continue;
				const target = computeTarget(state, now);
				if (!target) continue;
				easeMarkerTo(
					() => {
						const c = entry.marker.getLatLng();
						return [c.lat, c.lng];
					},
					(next) => entry.marker.setLatLng(next),
					target,
				);
			}
			rafId = window.requestAnimationFrame(tick);
		};
		rafId = window.requestAnimationFrame(tick);
		return () => window.cancelAnimationFrame(rafId);
	}, [mapReady]);

	// Keep currentFilterRef in sync + rewrite hash when filter toggles.
	useEffect(() => {
		currentFilterRef.current = filter;
		hashWriterRef.current?.();
	}, [filter]);

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
			<div className="mb-3 flex justify-between text-sm">
				<span>
					{visibleCount} {texts.vehicles}
					{visibleCount === 0 ? ` — ${texts.noVehicles}` : ""}
				</span>
				<span className="text-dimmed">
					{texts.lastUpdate}: {lastUpdate}
				</span>
			</div>

			<div
				ref={mapElRef}
				className="rounded-lg border border-border overflow-hidden"
				style={{ height: "calc(100dvh - 200px)", minHeight: 400 }}
			/>

			<div className="mt-3 flex flex-wrap gap-2">
				{FILTERS.map((f) => {
					const active = filter === f.key;
					return (
						<button
							key={f.key}
							type="button"
							onClick={() => setFilter(f.key)}
							className={`px-2.5 py-1 text-xs font-medium rounded-full border border-border cursor-pointer transition-colors ${
								active
									? "bg-surface-hover text-fg"
									: "bg-transparent text-muted hover:text-fg"
							}`}
						>
							{f.key === "all" ? texts.filterAll : f.label}
						</button>
					);
				})}
			</div>
		</>
	);
}

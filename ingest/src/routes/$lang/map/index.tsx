import { createFileRoute, Link } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Lang } from "../../../lib/i18n.ts";
import {
	AUTH,
	CLIENT,
	decodeEncodedPolyline,
	MGATE_URL,
} from "../../../lib/mgate.ts";

const FRANKFURT_CENTER = { lat: 50.1109, lon: 8.6821 };
const POLL_INTERVAL = 15_000;
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
	bg: string;
	delay: number | null;
	occupancy: "L" | "M" | "H" | null;
	hasRT: boolean;
	bahnExpertUrl: string | null;
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
	"S-Bahn": "#009757",
	"U-Bahn": "#0065ae",
	Tram: "#ef7d00",
	Bus: "#a71680",
	AST: "#d5a601",
	Other: "#666",
};

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
							polyL?: { crdEncYX?: string }[];
							tcocL?: { r?: number; s?: string }[];
						};
						jnyL?: {
							jid: string;
							date?: string;
							pos: { x: number; y: number };
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

			const vehicles: Vehicle[] = jnyL.map((j) => {
				const prod = j.prodX != null ? prodL[j.prodX] : undefined;
				const oprIdx = prod?.oprX;
				const category = classifyProduct(prod?.cls ?? 0);
				const bg = CATEGORY_COLORS[category] ?? "#666";
				const hasRT = (j.stopL ?? []).some((s) => s.dTimeR != null);

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
				let bahnExpertUrl: string | null = null;
				if (RAIL_CATEGORIES.has(category)) {
					const depTime = (j.stopL ?? [])[0]?.dTimeS;
					if (depTime && j.date) {
						const y = j.date.slice(0, 4);
						const mo = j.date.slice(4, 6);
						const dy = j.date.slice(6, 8);
						const hh = depTime.slice(0, 2);
						const mm = depTime.slice(2, 4);
						const trainName = prod?.name?.trim() ?? "";
						if (trainName) {
							bahnExpertUrl = `https://bahn.expert/details/${encodeURIComponent(trainName)}/${y}-${mo}-${dy}T${hh}:${mm}:00.000Z`;
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
					category,
					operator: oprIdx != null ? (opL[oprIdx]?.name ?? "") : "",
					bg,
					delay,
					occupancy,
					hasRT,
					bahnExpertUrl,
					waypoints,
					fetchedAt: serverTime,
				};
			});

			return { vehicles, serverTime };
		},
	);

type MapSearch = { z?: number; lat?: number; lon?: number };

export const Route = createFileRoute("/$lang/map/")({
	head: () => ({
		meta: [{ title: "DummRum — Live Map" }],
	}),
	validateSearch: (search: Record<string, unknown>): MapSearch => ({
		z: typeof search.z === "number" ? search.z : undefined,
		lat: typeof search.lat === "number" ? search.lat : undefined,
		lon: typeof search.lon === "number" ? search.lon : undefined,
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
	const pointer = `<polygon points="${c + tipDist},${c} ${c + r * 0.6},${c - spread} ${c + r * 0.6},${c + spread}" fill="${v.bg}" stroke="#fff" stroke-width="2" stroke-linejoin="round"/>`;

	const ir = r * 0.72;
	const gs = (ir * 2) / 100;
	const go = c - ir;
	const innerGlyph = `<g transform="translate(${go},${go}) scale(${gs})">${glyph}</g>`;

	const pin = `<g transform="rotate(${headingDeg},${c},${c})">${pointer}</g><circle cx="${c}" cy="${c}" r="${r}" fill="${v.bg}" stroke="#fff" stroke-width="2"/><circle cx="${c}" cy="${c}" r="${ir}" fill="#fff"/>${innerGlyph}`;

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

	const opacity = v.hasRT ? 1 : 0.45;
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

function MapPage() {
	const { lang } = Route.useParams();
	const l = lang as Lang;
	const search = Route.useSearch();
	const navigate = Route.useNavigate();
	const mapRef = useRef<HTMLDivElement>(null);
	const leafletMap = useRef<L.Map | null>(null);
	const markersRef = useRef<
		Map<string, { marker: L.Marker; iconKey: string; layerKey: string }>
	>(new Map());
	const vehiclesRef = useRef<Vehicle[]>([]);
	const timeDeltaRef = useRef(0);
	const animRef = useRef<number | null>(null);
	const followIdRef = useRef<string | null>(null);
	const [followName, setFollowName] = useState<string | null>(null);
	const userPanRef = useRef(false);
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
			const pos = interpolateVehicle(v, Date.now() + timeDeltaRef.current);
			const layerKey = `${v.category}${v.hasRT ? "" : " (sched)"}`;
			const layer = layers.get(layerKey);
			if (!layer) continue;
			const iconKey = `${size}|${showLabel}|${v.heading}|${v.category}|${v.delay}|${v.occupancy}|${v.hasRT}`;

			const entry = existing.get(v.id);
			if (entry) {
				entry.marker.setLatLng([pos.lat, pos.lon]);
				if (entry.iconKey !== iconKey) {
					entry.marker.setIcon(
						L.divIcon({
							html: buildVehicleIcon(v, pos.heading, size, showLabel),
							iconSize: [size, size],
							iconAnchor: [size / 2, size / 2],
							className: "",
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
					className: "",
				});
				const marker = L.marker([pos.lat, pos.lon], { icon }).addTo(layer);
				marker.on("click", () => {
					const current = vehiclesRef.current.find(
						(cv) => cv.id === v.id,
					);
					followIdRef.current = v.id;
					setFollowName(current?.name ?? v.name);
					userPanRef.current = false;
				});
				existing.set(v.id, { marker, iconKey, layerKey });
			}

			const isFollowed = v.id === followIdRef.current;
			const m = existing.get(v.id)!.marker;
			const bahnLink =
				v.bahnExpertUrl && v.delay && v.delay > 2
					? `<br/><a href="${v.bahnExpertUrl}" target="_blank" rel="noopener" style="font-size:11px;color:var(--accent,#0969da)">Delay info →</a>`
					: "";
			const content = `<strong>${escapeHtml(v.name)}</strong><br/>→ ${escapeHtml(v.direction)}${v.operator ? `<br/><span style="opacity:.7">${escapeHtml(v.operator)}</span>` : ""}${bahnLink}`;

			m.unbindPopup();
			m.bindPopup(content, {
				offset: [0, -(size / 2 + 4)],
				autoPan: false,
			});
			if (isFollowed) m.openPopup();
		}

		for (const [id, entry] of existing) {
			if (!seen.has(id)) {
				entry.marker.remove();
				existing.delete(id);
			}
		}
	}, []);

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
					products: 1023,
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
			await syncMarkers();
		} catch {
			/* network error, keep stale data */
		}
		setLoading(false);
	}, []);

	loadRef.current = load;

	useEffect(() => {
		if (!mapRef.current || leafletMap.current) return;

		let cancelled = false;

		(async () => {
			const L = await import("leaflet");
			if (cancelled) return;

			await import("leaflet-fullscreen");

			const initLat = search.lat ?? FRANKFURT_CENTER.lat;
			const initLon = search.lon ?? FRANKFURT_CENTER.lon;
			const initZoom = search.z ?? 13;

			const map = L.map(mapRef.current!, {
				center: [initLat, initLon],
				zoom: initZoom,
				zoomControl: false,
				fullscreenControl: { position: "topright" },
			});

			L.control.zoom({ position: "topright" }).addTo(map);

			const lc = await import("leaflet.locatecontrol");
			const locateFactory = (lc as unknown as { locate: (opts: Record<string, unknown>) => L.Control }).locate;
			locateFactory({
				position: "topright",
				flyTo: true,
				keepCurrentZoomLevel: true,
				strings: { title: "My location" },
			}).addTo(map);

			L.tileLayer("https://tileserver.memomaps.de/tilegen/{z}/{x}/{y}.png", {
				maxZoom: 18,
				attribution:
					'Map © <a href="https://memomaps.de/">MeMoMaps</a> · Data © <a href="https://www.openstreetmap.org/copyright">OSM</a> · Vehicles © <a href="https://www.rmv.de">RMV</a>',
			}).addTo(map);

			leafletMap.current = map;

			const layers = new Map<string, L.LayerGroup>();
			const CATS = [
				"Fernverkehr",
				"Regionalverkehr",
				"S-Bahn",
				"U-Bahn",
				"Tram",
				"Bus",
				"AST",
				"Other",
			];
			for (const cat of CATS) {
				layers.set(cat, L.layerGroup().addTo(map));
				layers.set(`${cat} (sched)`, L.layerGroup().addTo(map));
			}
			categoryLayersRef.current = layers;

			const allRt = CATS.map((c) => layers.get(c)!);
			const allSched = CATS.map((c) => layers.get(`${c} (sched)`)!);

			const FilterControl = L.Control.extend({
				onAdd() {
					const el = L.DomUtil.create("div", "leaflet-bar leaflet-control");
					Object.assign(el.style, {
						background: "var(--surface, #fff)",
						color: "var(--fg, #333)",
						padding: "6px 8px",
						fontSize: "11px",
						lineHeight: "1.8",
						maxHeight: "70vh",
						overflowY: "auto",
					});
					L.DomEvent.disableClickPropagation(el);
					L.DomEvent.disableScrollPropagation(el);

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
						el.appendChild(h);
					};

					const addToggle = (
						icon: string,
						label: string,
						groups: L.LayerGroup[],
						checked: boolean,
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
						cb.addEventListener("change", () => {
							for (const g of groups)
								cb.checked ? map.addLayer(g) : map.removeLayer(g);
						});
						el.appendChild(row);
					};

					const catIcon = (cat: string) => {
						const color = CATEGORY_COLORS[cat] ?? "#666";
						const glyph = buildIconGlyph(resolveIconType(cat), "#fff");
						return `<svg width="16" height="16" viewBox="0 0 100 100" style="vertical-align:middle"><circle cx="50" cy="50" r="46" fill="${color}"/>${glyph}</svg>`;
					};

					addHeading("Data");
					addToggle(
						'<svg width="16" height="16" viewBox="0 0 16 16" style="vertical-align:middle"><circle cx="8" cy="8" r="7" fill="#27ae60"/><text x="8" y="11.5" text-anchor="middle" font-size="9" font-weight="bold" fill="#fff">RT</text></svg>',
						" Realtime",
						allRt,
						true,
					);
					addToggle(
						'<svg width="16" height="16" viewBox="0 0 16 16" style="vertical-align:middle"><circle cx="8" cy="8" r="7" fill="#999" opacity=".45"/><text x="8" y="11" text-anchor="middle" font-size="7" font-weight="bold" fill="#fff">SCH</text></svg>',
						" Schedule",
						allSched,
						true,
					);

					addHeading("Vehicles");
					for (const cat of CATS) {
						if (cat === "Other") continue;
						addToggle(catIcon(cat), ` ${cat}`, [
							layers.get(cat)!,
							layers.get(`${cat} (sched)`)!,
						], true);
					}

					return el;
				},
			});
			new FilterControl({ position: "topright" }).addTo(map);

			map.on("dragstart", () => {
				userPanRef.current = true;
				followIdRef.current = null;
				setFollowName(null);
			});

			map.on("moveend", () => {
				loadRef.current?.();
				const c = map.getCenter();
				const z = map.getZoom();
				navigate({
					search: {
						z: Math.round(z),
						lat: Math.round(c.lat * 1e5) / 1e5,
						lon: Math.round(c.lng * 1e5) / 1e5,
					},
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
		};
	}, []);

	useEffect(() => {
		if (intervalRef.current) clearInterval(intervalRef.current);
		intervalRef.current = setInterval(() => loadRef.current?.(), POLL_INTERVAL);
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
				const entry = existing.get(v.id);
				if (!entry || v.waypoints.length < 2) continue;
				const pos = interpolateVehicle(v, now);
				entry.marker.setLatLng([pos.lat, pos.lon]);
				if (
					v.id === followIdRef.current &&
					leafletMap.current &&
					!userPanRef.current
				) {
					leafletMap.current.panTo([pos.lat, pos.lon], { animate: false });
				}
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
			<link
				rel="stylesheet"
				href="https://unpkg.com/leaflet.locatecontrol@0.89.0/dist/L.Control.Locate.min.css"
			/>
			<div className="flex items-center gap-2 px-3 py-2 bg-surface border-b border-border z-[1000] overflow-x-auto shrink-0">
				<Link
					to="/$lang"
					params={{ lang: l }}
					className="text-sm font-semibold text-fg no-underline hover:text-accent shrink-0"
				>
					← DummRum
				</Link>
				{followName && (
					<>
						<span className="text-border">|</span>
						<span className="text-xs text-fg font-medium shrink-0 flex items-center gap-1">
							Following {followName}
							<button
								type="button"
								onClick={() => {
									followIdRef.current = null;
									setFollowName(null);
								}}
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

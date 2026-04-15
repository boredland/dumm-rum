#!/usr/bin/env node
// Empirical harness for the live map.
//
// Drives a headless Chromium against /en/map, patches `L.map` to expose
// the Leaflet instance, samples every vehicle marker's lat/lon at 500ms
// intervals for a configurable window, and reports the distribution of
// per-frame jump distances. Useful for A/Bing client-side animation
// changes (ease rates, drift caps, velocity extrapolation, etc.) against
// real production data without waiting for a CI deploy.
//
// Fast iteration loop:
//   1. `npm run dev` — astro dev server on :4321 proxies /api/live-map
//      to production (see astro.config.ts dev-only proxy).
//   2. Edit `src/pages/[lang]/map.astro`. Vite hot-reloads.
//   3. `npm run watch-map` — re-measures in ~90 seconds.
//
// Requires playwright's chromium-headless-shell. Install once:
//   npx playwright install chromium

import { chromium } from "playwright";

const URL = process.env.MAP_URL ?? "http://localhost:4321/en/map";
const SAMPLE_MS = Number(process.env.SAMPLE_MS ?? 500);
const SAMPLE_COUNT = Number(process.env.SAMPLE_COUNT ?? 120);

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await ctx.newPage();
page.on("pageerror", (e) => console.error("PAGE ERROR:", e.message));
page.on("console", (m) => {
	if (m.type() === "error") console.error("CONSOLE ERROR:", m.text());
});

// The map script keeps its Leaflet instance in a module-scope `map` closure.
// Before any page script runs, patch `L.map` so the first instance created
// exposes itself on `window.__dumm_map__` for us to introspect.
await page.addInitScript(() => {
	const poll = () => {
		if (!window.L?.map) return setTimeout(poll, 10);
		const orig = window.L.map;
		window.L.map = (...args) => {
			const m = orig.apply(window.L, args);
			window.__dumm_map__ = m;
			return m;
		};
	};
	poll();
});

console.error(`loading ${URL}…`);
await page.goto(URL, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => window.__dumm_map__, null, { timeout: 20000 });
console.error("map ready, waiting 6s for first fetch");
await page.waitForTimeout(6000);

async function sample() {
	return await page.evaluate(() => {
		const lmap = window.__dumm_map__;
		if (!lmap?.eachLayer) return null;
		const out = [];
		lmap.eachLayer((layer) => {
			if (layer.getLatLng && layer._vehicleCategory !== undefined) {
				const ll = layer.getLatLng();
				out.push({
					lid: layer._leaflet_id,
					lat: ll.lat,
					lon: ll.lng,
					cat: layer._vehicleCategory,
				});
			}
		});
		return out;
	});
}

console.error(`sampling ${SAMPLE_COUNT} × ${SAMPLE_MS}ms…`);
const snapshots = [];
for (let i = 0; i < SAMPLE_COUNT; i++) {
	const s = await sample();
	if (s) snapshots.push({ t: Date.now(), vehicles: s });
	await page.waitForTimeout(SAMPLE_MS);
}
await browser.close();

if (snapshots.length < 3) {
	console.error("no useful snapshots");
	process.exit(1);
}

const trajByLid = new Map();
for (const snap of snapshots) {
	for (const v of snap.vehicles) {
		if (!trajByLid.has(v.lid)) trajByLid.set(v.lid, []);
		trajByLid.get(v.lid).push({ t: snap.t, lat: v.lat, lon: v.lon, cat: v.cat });
	}
}

// Rough meters at Frankfurt latitude.
const distM = (a, b) =>
	Math.hypot((a.lat - b.lat) * 111000, (a.lon - b.lon) * 70000);

const frameJumps = [];
for (const [lid, traj] of trajByLid) {
	for (let i = 1; i < traj.length; i++) {
		const dt = (traj[i].t - traj[i - 1].t) / 1000;
		const d = distM(traj[i - 1], traj[i]);
		frameJumps.push({
			lid,
			cat: traj[i].cat,
			distM: d,
			dtSec: dt,
			speedKmh: (d / dt) * 3.6,
		});
	}
}
frameJumps.sort((a, b) => b.distM - a.distM);

console.log(
	"snapshots:",
	snapshots.length,
	"unique markers:",
	trajByLid.size,
	"inter-frame samples:",
	frameJumps.length,
);

const buckets = {
	"0-2m": 0,
	"2-10m": 0,
	"10-30m": 0,
	"30-100m": 0,
	"100-300m": 0,
	"300m-1km": 0,
	">1km": 0,
};
for (const j of frameJumps) {
	if (j.distM < 2) buckets["0-2m"]++;
	else if (j.distM < 10) buckets["2-10m"]++;
	else if (j.distM < 30) buckets["10-30m"]++;
	else if (j.distM < 100) buckets["30-100m"]++;
	else if (j.distM < 300) buckets["100-300m"]++;
	else if (j.distM < 1000) buckets["300m-1km"]++;
	else buckets[">1km"]++;
}
console.log("\nPer-500ms-frame shift distribution:", buckets);
console.log("\nTop 15 biggest single-frame jumps:");
for (const j of frameJumps.slice(0, 15)) {
	console.log(
		`  ${(j.cat ?? "?").padEnd(22)} ${Math.round(j.distM)
			.toString()
			.padStart(5)}m over ${j.dtSec.toFixed(2)}s = ${Math.round(j.speedKmh)
			.toString()
			.padStart(5)}km/h`,
	);
}

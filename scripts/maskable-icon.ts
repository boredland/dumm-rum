/** Derives `public/icon-maskable-512.png` from `public/icon-512.png`.
 *
 *   bun scripts/maskable-icon.ts
 *
 * The source icon is a rounded rectangle on white corners. Declared as
 * `maskable` it would be cropped to the launcher's own shape — a circle on
 * most Android launchers — cutting the corners off and leaving white
 * slivers. A maskable icon instead bleeds its background to every edge and
 * keeps the artwork inside the safe zone (the centre 80%), so any mask the
 * platform applies lands on background.
 */

import { Buffer } from "node:buffer";
import { chromium } from "playwright";

const PUBLIC = new URL("../public/", import.meta.url).pathname;
const SIZE = 512;
/** W3C safe zone: artwork must sit inside the centre 80% of the canvas. */
const SAFE = 0.8;

const src = await Bun.file(`${PUBLIC}icon-512.png`).bytes();
const b64 = Buffer.from(src).toString("base64");

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: SIZE, height: SIZE } });

// The background colour is sampled from the source icon's own body rather
// than hardcoded, so a redesign of the icon cannot leave the two disagreeing.
await page.setContent(
	`<!doctype html><meta charset="utf-8"><style>
	*{margin:0;padding:0}
	body{width:${SIZE}px;height:${SIZE}px;overflow:hidden}
	#bg{width:100%;height:100%;display:flex;align-items:center;justify-content:center}
	#art{width:${SAFE * 100}%;height:${SAFE * 100}%;object-fit:contain}
	</style>
	<body><div id="bg"><img id="art" src="data:image/png;base64,${b64}"></div></body>`,
	{ waitUntil: "load" },
);

const bg = await page.evaluate(async () => {
	const img = document.querySelector("img") as HTMLImageElement;
	await img.decode();
	const c = document.createElement("canvas");
	c.width = img.naturalWidth;
	c.height = img.naturalHeight;
	const ctx = c.getContext("2d");
	if (!ctx) throw new Error("no 2d context");
	ctx.drawImage(img, 0, 0);
	const [r, g, b] = ctx.getImageData(c.width / 2, c.height / 2, 1, 1).data;
	const colour = `rgb(${r},${g},${b})`;
	(document.getElementById("bg") as HTMLElement).style.background = colour;
	return colour;
});

await page.screenshot({ path: `${PUBLIC}icon-maskable-512.png` });
await browser.close();
console.log(`wrote icon-maskable-512.png (background ${bg})`);

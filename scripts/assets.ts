/** Regenerates the static share and install assets in `public/`:
 *
 *   og.png              1200×630 link preview card
 *   screenshot-*.png    manifest screenshots (install prompt / store listing)
 *
 * Run against a server serving the built app:
 *
 *   bun run build
 *   DATABASE_URL=… bun serve.ts &
 *   bun scripts/assets.ts [http://localhost:3000]
 *
 * Not part of `bun run build` — it needs a database and a browser, and the
 * output only changes when the design does. The PNGs are committed so a
 * deploy depends on neither.
 */

import { chromium } from "playwright";

const OUT = new URL("../public/", import.meta.url).pathname;
const FONT_DIR = new URL("../node_modules/@fontsource/", import.meta.url)
	.pathname;

/** Fonts are inlined as data URLs rather than linked: the card is rendered
 * from `setContent`, which has no document base URL to resolve a relative
 * font path against, so a linked face silently falls back to a serif. */
async function fontFace(
	family: string,
	file: string,
	weight: number,
): Promise<string> {
	const data = await Bun.file(`${FONT_DIR}${file}`).bytes();
	const b64 = Buffer.from(data).toString("base64");
	return `@font-face{font-family:"${family}";font-style:normal;font-weight:${weight};font-display:block;src:url("data:font/woff2;base64,${b64}") format("woff2")}`;
}

/** The card, set like the site: paper, one reading column, a rule instead
 * of boxes, the mono face on anything that reads as a figure.
 *
 * It names the three things the site measures rather than quoting a rate.
 * A number baked into a PNG would be a claim that stops being true the day
 * after it is generated, and nothing regenerates this on a schedule. */
export async function ogHtml(): Promise<string> {
	const fonts = (
		await Promise.all([
			fontFace(
				"Fira Sans",
				"fira-sans/files/fira-sans-latin-ext-400-normal.woff2",
				400,
			),
			fontFace(
				"Fira Sans",
				"fira-sans/files/fira-sans-latin-ext-500-normal.woff2",
				500,
			),
			fontFace(
				"Fira Sans",
				"fira-sans/files/fira-sans-latin-ext-700-normal.woff2",
				700,
			),
			fontFace(
				"Fira Mono",
				"fira-mono/files/fira-mono-latin-ext-400-normal.woff2",
				400,
			),
		])
	).join("\n");

	return `<!doctype html><html lang="de"><meta charset="utf-8"><style>
${fonts}
*{margin:0;padding:0;box-sizing:border-box}
body{width:1200px;height:630px;background:#fbfcfd;color:#12141c;
	font-family:"Fira Sans",sans-serif;display:flex;flex-direction:column;
	justify-content:space-between;padding:64px 76px;
	-webkit-font-smoothing:antialiased}
.eyebrow{font-size:21px;font-weight:500;text-transform:uppercase;
	letter-spacing:.1em;color:#545a6b}
h1{font-size:68px;line-height:1.1;letter-spacing:-.02em;font-weight:700;
	margin-top:18px}
.sub{font-size:26px;color:#545a6b;margin-top:20px;max-width:40ch;
	line-height:1.45}
.rule{border-top:2px solid #12141c;padding-top:24px;display:flex;gap:56px}
.metric{display:flex;flex-direction:column;gap:6px}
.metric .label{font-size:18px;text-transform:uppercase;letter-spacing:.08em;
	color:#545a6b}
.metric .word{font-family:"Fira Mono",monospace;font-size:30px}
.bad{color:#b81e40}.ghost{color:#4b3f8f}.mixed{color:#a35a00}
footer{display:flex;justify-content:space-between;align-items:baseline;
	font-size:22px;color:#545a6b;border-top:1px solid #d3d9e6;padding-top:20px}
footer .host{font-family:"Fira Mono",monospace;color:#12141c;font-size:24px}
</style>
<body>
	<div>
		<div class="eyebrow">DummRum</div>
		<h1>Wissen, ob man dumm rumsteht</h1>
		<p class="sub">Ausfälle, Geisterfahrten und Verspätungen im Frankfurter Nahverkehr — täglich gemessen.</p>
	</div>
	<div class="rule">
		<div class="metric"><span class="label">Ausfälle</span><span class="word bad">gestrichen</span></div>
		<div class="metric"><span class="label">Geisterfahrten</span><span class="word ghost">nie gefahren</span></div>
		<div class="metric"><span class="label">Verspätungen</span><span class="word mixed">ab 7,5 min</span></div>
	</div>
	<footer><span>Datenquelle: RMV-Echtzeitfeed</span><span class="host">dummrum.de</span></footer>
</body></html>`;
}

/** Manifest screenshots. `form_factor: "wide"` needs a desktop-shaped shot
 * and `"narrow"` a phone-shaped one; a manifest declaring only one of them
 * gets no richer install prompt at all. */
const SHOTS = [
	{ name: "screenshot-wide.png", width: 1280, height: 800, path: "/de" },
	{ name: "screenshot-narrow.png", width: 430, height: 932, path: "/de" },
	{
		name: "screenshot-narrow-station.png",
		width: 430,
		height: 932,
		path: "/de/hauptbahnhof",
	},
] as const;

async function main(base: string): Promise<void> {
	const browser = await chromium.launch();

	const ogPage = await browser.newPage({
		viewport: { width: 1200, height: 630 },
	});
	await ogPage.setContent(await ogHtml(), { waitUntil: "load" });
	await ogPage.evaluate(() => document.fonts.ready);
	await ogPage.screenshot({ path: `${OUT}og.png` });
	console.log("wrote og.png");

	for (const shot of SHOTS) {
		const page = await browser.newPage({
			viewport: { width: shot.width, height: shot.height },
			colorScheme: "light",
		});
		await page.goto(`${base}${shot.path}`, { waitUntil: "networkidle" });
		await page.evaluate(() => document.fonts.ready);
		await page.screenshot({ path: `${OUT}${shot.name}` });
		await page.close();
		console.log(`wrote ${shot.name}`);
	}

	await browser.close();
}

if (import.meta.main) {
	await main(process.argv[2] ?? "http://localhost:3000");
}

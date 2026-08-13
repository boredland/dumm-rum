// Tiny bootstrap: imports the built TanStack Start fetch handler and
// serves it via Bun.serve. Kept outside src/ so it's not typechecked
// against schema (dist/ only exists after `vite build`).
//
// Static assets from `dist/client/` (built JS/CSS bundles + files copied
// from `public/`) are served directly from disk; anything else falls
// through to the TanStack request handler.

import { resolve, sep } from "node:path";

import { handleTelegramWebhook } from "./src/lib/telegram.ts";

const entry = (await import("./dist/server/server.js")).default as {
	fetch: (req: Request) => Response | Promise<Response>;
};

const CLIENT_DIR = resolve("./dist/client");
const CLIENT_PREFIX = CLIENT_DIR + sep;
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

const port = Number(process.env.PORT ?? 3000);

/** Resolves a request path to a file inside `dist/client`, or null when it
 * escapes or the path is malformed.
 *
 * `new URL()` already collapses `../` and never decodes `%2e%2e`, so no
 * traversal reaches this today. That is a property of the parser rather
 * than of this handler, though, and the handler is what concatenates a
 * request-controlled string onto a filesystem path — so it verifies the
 * resolved path itself instead of trusting a caller it does not own.
 *
 * Decoding is required for the check to mean anything: without it, a
 * legitimate asset with an escaped character would miss on disk, and any
 * future decode upstream would sail past a check done on raw bytes. A
 * malformed escape throws, and is treated as no asset. */
function resolveAsset(pathname: string): string | null {
	let decoded: string;
	try {
		decoded = decodeURIComponent(pathname);
	} catch {
		return null;
	}
	if (decoded.includes("\0")) return null;
	const path = resolve(CLIENT_DIR + decoded);
	return path.startsWith(CLIENT_PREFIX) ? path : null;
}

Bun.serve({
	port,
	// Cold summary aggregations (getStopSummaries runs ~5 s on prod) can
	// exceed the 10 s Bun default when the boot warmup hasn't landed yet.
	idleTimeout: 30,
	async fetch(req) {
		const url = new URL(req.url);

		// Telegram webhook — intercept before SSR so it's fast and
		// doesn't go through the React pipeline.
		if (
			TELEGRAM_TOKEN &&
			req.method === "POST" &&
			url.pathname === `/api/telegram/${TELEGRAM_TOKEN}`
		) {
			try {
				const body = await req.json();
				await handleTelegramWebhook(TELEGRAM_TOKEN, body);
			} catch (e) {
				console.error("telegram webhook error:", e);
			}
			return new Response("ok");
		}

		// Only attempt static lookup for paths that look like file requests
		// (have an extension). Avoids touching disk for every SSR route.
		if (/\.[a-z0-9]+$/i.test(url.pathname)) {
			const assetPath = resolveAsset(url.pathname);
			const file = assetPath ? Bun.file(assetPath) : null;
			if (file && (await file.exists())) {
				const noCache = url.pathname.endsWith("/sw.js");
				return new Response(file, {
					headers: {
						"Cache-Control": noCache
							? "no-cache"
							: url.pathname.startsWith("/assets/")
								? "public, max-age=31536000, immutable"
								: "public, max-age=300",
					},
				});
			}
		}

		const res = await entry.fetch(req);

		// Only successful HTML responses are cacheable. Gating on status
		// keeps 404s (e.g. bookmarked URLs for since-removed routes),
		// SSR errors, and redirects out of the edge cache. The live map
		// sets its own Cache-Control, which the has() check below leaves
		// untouched.
		if (
			req.method === "GET" &&
			res.ok &&
			!url.searchParams.has("_serverFnId")
		) {
			const headers = new Headers(res.headers);
			if (!headers.has("Cache-Control"))
				headers.set(
					"Cache-Control",
					"public, max-age=60, stale-while-revalidate=300",
				);
			return new Response(res.body, { status: res.status, headers });
		}

		return res;
	},
});
console.log(`ui listening on :${port}`);

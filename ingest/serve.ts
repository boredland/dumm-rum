// Tiny bootstrap: imports the built TanStack Start fetch handler and
// serves it via Bun.serve. Kept outside src/ so it's not typechecked
// against schema (dist/ only exists after `vite build`).
//
// Static assets from `dist/client/` (built JS/CSS bundles + files copied
// from `public/`) are served directly from disk; anything else falls
// through to the TanStack request handler.

import { handleTelegramWebhook } from "./src/lib/telegram.ts";

const entry = (await import("./dist/server/server.js")).default as {
	fetch: (req: Request) => Response | Promise<Response>;
};

const CLIENT_DIR = "./dist/client";
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

const port = Number(process.env.PORT ?? 3000);

Bun.serve({
	port,
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
			const file = Bun.file(`${CLIENT_DIR}${url.pathname}`);
			if (await file.exists()) {
				return new Response(file, {
					headers: {
						"Cache-Control": url.pathname.startsWith("/assets/")
							? "public, max-age=31536000, immutable"
							: "public, max-age=300",
					},
				});
			}
		}

		return entry.fetch(req);
	},
});
console.log(`ui listening on :${port}`);

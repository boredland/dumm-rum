import { handle } from "@astrojs/cloudflare/handler";
import { createDb } from "./db/client";
import { runCollection } from "./lib/collect";
import { snapshotJourneys } from "./lib/journeyRuns";
import { STATIONS } from "./lib/stations";
import { handleTelegramWebhook } from "./lib/telegram";
import { nowBerlin, todayBerlin } from "./lib/utils";

const CACHE_TTL = 300;

export default {
	async fetch(request: Request, env: Cloudflare.Env, ctx: ExecutionContext) {
		const url = new URL(request.url);
		if (
			url.pathname === `/api/telegram/${env.TELEGRAM_BOT_TOKEN}` &&
			request.method === "POST"
		) {
			const db = createDb(env.DB);
			const body = (await request.json()) as Parameters<
				typeof handleTelegramWebhook
			>[2];
			ctx.waitUntil(handleTelegramWebhook(db, env.TELEGRAM_BOT_TOKEN, body));
			return new Response("ok");
		}

		if (request.method === "GET") {
			const cache = (caches as unknown as { default: Cache }).default;
			const skipCache = request.headers.get("Cache-Purge") === "1";
			if (!skipCache) {
				const cached = await cache.match(request);
				if (cached) return cached;
			}

			const response = await handle(request, env, ctx);
			const contentType = response.headers.get("content-type") ?? "";
			if (
				response.status === 200 &&
				(contentType.includes("text/html") ||
					contentType.includes("application/json"))
			) {
				response.headers.set(
					"Cache-Control",
					`public, s-maxage=${CACHE_TTL}, stale-while-revalidate=${CACHE_TTL}`,
				);
				ctx.waitUntil(cache.put(request, response.clone()));
			}
			return response;
		}

		return handle(request, env, ctx);
	},

	async scheduled(
		_controller: ScheduledController,
		env: Cloudflare.Env,
		ctx: ExecutionContext,
	) {
		const db = createDb(env.DB);

		// Once-per-day window: snapshot yesterday's journeys into journey_runs.
		// The 3-min cron means exactly one tick lands in the [02:00, 02:03) slot.
		const berlinNow = nowBerlin();
		if (berlinNow.hour() === 2 && berlinNow.minute() < 3) {
			const yesterday = berlinNow.subtract(1, "day").format("YYYY-MM-DD");
			const apiKey = env.RMV_API_KEY.split(",")[0].trim();
			ctx.waitUntil(
				snapshotJourneys(db, apiKey, yesterday)
					.then((r) =>
						console.log(
							`journey snapshot for ${yesterday}: discovered=${r.discovered} upserted=${r.upserted} failed=${r.failed}`,
						),
					)
					.catch((e) => console.error("journey snapshot failed:", e)),
			);
		}

		const { linesToday, operatorsToday } = await runCollection(
			db,
			env.AI,
			env.RMV_API_KEY,
			env.TELEGRAM_BOT_TOKEN,
		);

		const site = env.SITE_URL;
		if (site) {
			const today = todayBerlin();
			const langs = ["de", "en"];
			const paths: string[] = [""];
			for (const s of STATIONS) {
				paths.push(`/${s.slug}`, `/${s.slug}/day/${today}`);
			}
			for (const line of linesToday) {
				const enc = encodeURIComponent(line);
				paths.push(`/line/${enc}`, `/line/${enc}/day/${today}`);
			}
			for (const op of operatorsToday) {
				const enc = encodeURIComponent(op);
				paths.push(`/operator/${enc}`, `/operator/${enc}/day/${today}`);
			}
			const urls = langs.flatMap((l) => paths.map((p) => `${site}/${l}${p}`));
			ctx.waitUntil(
				Promise.all(
					urls.map((url) =>
						fetch(url, { headers: { "Cache-Purge": "1" } }).catch(() => {}),
					),
				),
			);
		}
	},
} satisfies ExportedHandler<Cloudflare.Env>;

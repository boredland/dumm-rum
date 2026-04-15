import cloudflare from "@astrojs/cloudflare";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "astro/config";

export default defineConfig({
	output: "server",
	adapter: cloudflare(),
	i18n: {
		locales: ["de", "en"],
		defaultLocale: "de",
		routing: {
			prefixDefaultLocale: true,
			redirectToDefaultLocale: false,
		},
	},
	vite: {
		plugins: [tailwindcss()],
		// Dev-only: proxy API endpoints to production so `astro dev` serves
		// map.astro on every edit while the browser sees real live data
		// (D1-backed) without a local DB copy. See scripts/watch-map.mjs.
		// Conditional so it doesn't apply during `astro build`.
		...(process.env.NODE_ENV === "production"
			? {}
			: {
					server: {
						proxy: {
							"/api/live-map": {
								target: "https://dummrum.de",
								changeOrigin: true,
								secure: true,
							},
						},
					},
				}),
	},
});

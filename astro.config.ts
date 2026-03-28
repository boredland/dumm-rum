import cloudflare from "@astrojs/cloudflare";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "astro/config";

export default defineConfig({
	output: "server",
	adapter: cloudflare({
		platformProxy: { enabled: true },
	}),
	vite: {
		// @ts-expect-error vite version mismatch between @tailwindcss/vite and astro's bundled vite
		plugins: [tailwindcss()],
	},
});

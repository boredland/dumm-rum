import type { KnipConfig } from "knip";

export default {
	project: ["src/**/*.{astro,ts}", "scripts/**/*.{mjs,ts}"],
	ignoreDependencies: ["tailwindcss", "cloudflare"],
	ignore: ["src/**/*.astro"],
	ignoreExportsUsedInFile: true,
} satisfies KnipConfig;

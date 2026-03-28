import type { KnipConfig } from "knip";

export default {
	project: ["src/**/*.{astro,ts}"],
	ignoreDependencies: ["tailwindcss", "cloudflare"],
	ignore: ["src/**/*.astro", "src/lib/hafas-types.ts"],
	ignoreExportsUsedInFile: true,
} satisfies KnipConfig;

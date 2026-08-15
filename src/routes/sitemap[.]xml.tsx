import { createFileRoute } from "@tanstack/react-router";
import { languages } from "../lib/i18n.ts";
import { getSitemapEntities } from "../lib/queries.ts";
import {
	canonicalUrl,
	entityRoute,
	type Route as SeoRoute,
} from "../lib/seo.ts";
import { makeSwr } from "../lib/swr.ts";

const CACHE_CONTROL =
	"public, max-age=3600, s-maxage=86400, stale-while-revalidate=86400";

function xmlEscape(s: string): string {
	return s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;");
}

/** One `<url>` per language, each carrying the full set of `hreflang`
 * alternates the entity pages also declare in their head. Google requires
 * the two to agree; declaring them in both places is the documented shape,
 * not a duplication. */
function urlEntry(route: SeoRoute, changefreq: string, priority: string) {
	const alternates = languages
		.map(
			(l) =>
				`\n\t\t<xhtml:link rel="alternate" hreflang="${l}" href="${xmlEscape(canonicalUrl(l, route))}"/>`,
		)
		.join("");
	return languages
		.map(
			(l) => `\t<url>
		<loc>${xmlEscape(canonicalUrl(l, route))}</loc>${alternates}
		<changefreq>${changefreq}</changefreq>
		<priority>${priority}</priority>
	</url>`,
		)
		.join("\n");
}

async function buildSitemap(): Promise<string> {
	const { stations, lines, operators } = await getSitemapEntities();
	const entries = [
		urlEntry("", "hourly", "1.0"),
		urlEntry("/map", "hourly", "0.7"),
		...stations.map((slug) =>
			urlEntry(entityRoute("station", slug), "daily", "0.8"),
		),
		...lines.map((slug) => urlEntry(entityRoute("line", slug), "daily", "0.8")),
		...operators.map((name) =>
			urlEntry(entityRoute("operator", name), "daily", "0.6"),
		),
	];
	return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">
${entries.join("\n")}
</urlset>
`;
}

/** The entity set only changes when a stop or line enters or leaves the
 * 30-day window, and the scan behind it is the same shape as the picker
 * aggregates. Crawlers refetch far more often than that, so a stale answer
 * beats making one wait on the scan. */
const sitemapSwr = makeSwr<string>(buildSitemap, {
	freshMs: 60 * 60_000,
	staleMs: 6 * 60 * 60_000,
});

export const Route = createFileRoute("/sitemap.xml")({
	server: {
		handlers: {
			GET: async () => {
				const body = await sitemapSwr.get("all");
				return new Response(body, {
					headers: {
						"Content-Type": "application/xml; charset=utf-8",
						"Cache-Control": CACHE_CONTROL,
					},
				});
			},
		},
	},
});

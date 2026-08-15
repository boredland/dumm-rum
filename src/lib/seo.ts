import { type Lang, languages, t } from "./i18n.ts";
import { onTimeRate } from "./utils.ts";

/** Public origin, hardcoded like `TELEGRAM_BOT`: canonical and Open Graph
 * URLs have to be absolute, and the head functions run in the client bundle
 * too, where server env vars don't exist. */
export const SITE_ORIGIN = "https://dummrum.de";

export const OG_IMAGE = `${SITE_ORIGIN}/og.png`;

const BRAND = "DummRum";

const OG_LOCALE: Record<Lang, string> = { de: "de_DE", en: "en_GB" };

/** A page addressed the way the router addresses it: the path below the
 * language prefix. `""` is the language home page. */
export type Route = string;

/** Path below `/$lang` for one entity, percent-encoded the way `Link`
 * encodes it — line slugs carry colons (`rmv:Bus:30`) and operator names
 * carry spaces. A canonical that differs from the crawled URL is a
 * canonical pointing at a redirect, so the two must be built the same way. */
export function entityRoute(
	kind: "station" | "line" | "operator",
	slug: string,
): Route {
	const path = encodeURIComponent(slug);
	if (kind === "station") return `/${path}`;
	return `/${kind}/${path}`;
}

export function canonicalUrl(lang: Lang, route: Route): string {
	return `${SITE_ORIGIN}/${lang}${route}`;
}

interface PageSeo {
	lang: Lang;
	/** Without the brand suffix — `pageHead` appends it. */
	title: string;
	description: string;
	route: Route;
	/** Thin, unbounded pages (the per-day departure lists) stay out of the
	 * index but keep passing link equity to the entity pages. */
	noindex?: boolean;
	/** Structured-data nodes to publish alongside the tags. Entity pages
	 * pass `entityJsonLd` plus a breadcrumb; the home page passes none. */
	jsonLd?: Array<Record<string, unknown>>;
}

/** Title, description, canonical, hreflang alternates and the social card
 * text for one page.
 *
 * Meta is deduplicated by `name`/`property` with the deepest match winning,
 * so a route only names what it changes and the root supplies the rest.
 * Links are *not* deduplicated, so only leaf routes may emit a canonical. */
export function pageHead({
	lang,
	title,
	description,
	route,
	noindex,
	jsonLd,
}: PageSeo) {
	const full = `${title} — ${BRAND}`;
	const url = canonicalUrl(lang, route);
	return {
		meta: [
			{ title: full },
			{ name: "description", content: description },
			{ property: "og:title", content: full },
			{ property: "og:description", content: description },
			{ property: "og:url", content: url },
			{ property: "og:locale", content: OG_LOCALE[lang] },
			{ name: "twitter:title", content: full },
			{ name: "twitter:description", content: description },
			...(noindex ? [{ name: "robots", content: "noindex, follow" }] : []),
			...(jsonLd ?? []),
		],
		links: [
			{ rel: "canonical", href: url },
			...languages.map((l) => ({
				rel: "alternate",
				hrefLang: l,
				href: canonicalUrl(l, route),
			})),
			{
				rel: "alternate",
				hrefLang: "x-default",
				href: canonicalUrl("de", route),
			},
		],
	};
}

interface Day {
	total: number;
	cancelled: number;
	delayed: number;
}

/** Reliability sentence for an entity, over the window the page's own
 * figures describe. Falls back to a windowless line when nothing has been
 * collected yet, so a newly seen stop never advertises "0 departures". */
export function entityDescription(
	lang: Lang,
	kind: "station" | "line" | "operator",
	name: string,
	days: Day[],
): string {
	let total = 0;
	let cancelled = 0;
	let delayed = 0;
	for (const d of days) {
		total += d.total;
		cancelled += d.cancelled;
		delayed += d.delayed;
	}
	if (total === 0) return t(lang, `seo.${kind}.empty`, { name });
	return t(lang, `seo.${kind}.description`, {
		name,
		total,
		score: onTimeRate(cancelled, delayed, total),
	});
}

/** Schema.org node for an entity page. `TransitStop` would be more specific
 * but carries no measurements; these pages are reports *about* a stop, so
 * they describe themselves as the dataset of observations behind them. */
export function entityJsonLd(opts: {
	lang: Lang;
	name: string;
	description: string;
	route: Route;
}) {
	return {
		"script:ld+json": {
			"@context": "https://schema.org",
			"@type": "Dataset",
			name: opts.name,
			description: opts.description,
			url: canonicalUrl(opts.lang, opts.route),
			inLanguage: opts.lang,
			isAccessibleForFree: true,
			creator: { "@type": "Organization", name: BRAND, url: SITE_ORIGIN },
			spatialCoverage: {
				"@type": "Place",
				name: "Frankfurt am Main",
				address: {
					"@type": "PostalAddress",
					addressLocality: "Frankfurt am Main",
					addressCountry: "DE",
				},
			},
		},
	};
}

/** Breadcrumb for an entity page. The site nests one level below the
 * language home, so every trail is two steps. */
export function breadcrumbJsonLd(
	lang: Lang,
	trail: Array<{ name: string; route: Route }>,
) {
	return {
		"script:ld+json": {
			"@context": "https://schema.org",
			"@type": "BreadcrumbList",
			itemListElement: trail.map((step, i) => ({
				"@type": "ListItem",
				position: i + 1,
				name: step.name,
				item: canonicalUrl(lang, step.route),
			})),
		},
	};
}

import "../styles.css";

import {
	createRootRoute,
	HeadContent,
	Outlet,
	Scripts,
	useLocation,
} from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { NotFoundPage } from "../components/NotFoundPage.tsx";
import { type Lang, languages } from "../lib/i18n.ts";
import { OG_IMAGE, SITE_ORIGIN } from "../lib/seo.ts";

export const Route = createRootRoute({
	head: () => ({
		// Site-wide defaults only. Anything a page can say better about
		// itself — title, description, canonical, og:url — is set by that
		// page's own head, which wins the name/property dedupe.
		meta: [
			{ charSet: "utf-8" },
			{ name: "viewport", content: "width=device-width, initial-scale=1" },
			{ title: "DummRum" },
			{ property: "og:type", content: "website" },
			{ property: "og:site_name", content: "DummRum" },
			{ property: "og:image", content: OG_IMAGE },
			{ property: "og:image:width", content: "1200" },
			{ property: "og:image:height", content: "630" },
			{ property: "og:image:alt", content: "DummRum" },
			{ name: "twitter:card", content: "summary_large_image" },
			{ name: "twitter:image", content: OG_IMAGE },
			{ name: "theme-color", content: "#fcfbf9" },
			{
				"script:ld+json": {
					"@context": "https://schema.org",
					"@type": "WebSite",
					name: "DummRum",
					url: SITE_ORIGIN,
					inLanguage: languages,
					publisher: {
						"@type": "Organization",
						name: "DummRum",
						url: SITE_ORIGIN,
						logo: `${SITE_ORIGIN}/icon-512.png`,
					},
				},
			},
		],
		links: [
			{
				rel: "icon",
				href: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🚏</text></svg>",
			},
			{ rel: "manifest", href: "/manifest.json" },
			{ rel: "apple-touch-icon", href: "/icon-192.png" },
		],
	}),
	component: RootComponent,
	notFoundComponent: NotFoundPage,
});

function RootComponent() {
	// Derive <html lang> from the URL prefix so the document advertises
	// the correct language for SEO + a11y. Fallback to "de" when no prefix.
	const { pathname } = useLocation();
	const first = pathname.split("/")[1];
	const lang: Lang = languages.includes(first as Lang) ? (first as Lang) : "de";

	return (
		<html lang={lang}>
			<head>
				<HeadContent />
			</head>
			<body>
				<Outlet />
				<ScrollToTop />
				<Scripts />
			</body>
		</html>
	);
}

function ScrollToTop() {
	const [visible, setVisible] = useState(false);

	useEffect(() => {
		const onScroll = () => setVisible(window.scrollY > 400);
		window.addEventListener("scroll", onScroll, { passive: true });
		return () => window.removeEventListener("scroll", onScroll);
	}, []);

	if (!visible) return null;

	return (
		<button
			type="button"
			onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}
			className="fixed bottom-6 right-6 z-50 bg-paper border border-rule w-9 h-9 flex items-center justify-center text-muted hover:text-ink hover:border-ink transition-colors"
			aria-label="Scroll to top"
		>
			<svg
				width="18"
				height="18"
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				strokeWidth="2"
				strokeLinecap="round"
				strokeLinejoin="round"
				role="img"
				aria-hidden
			>
				<title>Scroll to top</title>
				<path d="M18 15l-6-6-6 6" />
			</svg>
		</button>
	);
}

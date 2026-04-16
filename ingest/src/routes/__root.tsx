import "../styles.css";

import {
	createRootRoute,
	HeadContent,
	Outlet,
	Scripts,
	useLocation,
} from "@tanstack/react-router";
import { type Lang, languages } from "../lib/i18n.ts";

export const Route = createRootRoute({
	head: () => ({
		meta: [
			{ charSet: "utf-8" },
			{ name: "viewport", content: "width=device-width, initial-scale=1" },
			{ title: "DummRum" },
			{
				name: "description",
				content:
					"Frankfurt public transport reliability tracker — cancellations, delays, ghost departures.",
			},
			{ property: "og:type", content: "website" },
			{ property: "og:site_name", content: "DummRum" },
			{ property: "og:title", content: "DummRum" },
			{
				property: "og:description",
				content:
					"Frankfurt public transport reliability tracker — cancellations, delays, ghost departures.",
			},
			{ name: "twitter:card", content: "summary" },
		],
		links: [
			{
				rel: "icon",
				href: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🚏</text></svg>",
			},
		],
	}),
	component: RootComponent,
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
				<Scripts />
			</body>
		</html>
	);
}

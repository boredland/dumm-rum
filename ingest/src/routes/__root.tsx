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
			{ title: "dummrum ingest" },
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

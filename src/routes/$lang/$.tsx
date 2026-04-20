import { createFileRoute, Link } from "@tanstack/react-router";
import { type Lang, t } from "../../lib/i18n.ts";

export const Route = createFileRoute("/$lang/$")({
	component: NotFound,
});

function NotFound() {
	const { lang } = Route.useParams();
	const l = (lang === "en" ? "en" : "de") as Lang;
	return (
		<main className="mx-auto max-w-md p-12 text-center space-y-4">
			<div className="text-6xl">🚏</div>
			<h1 className="text-h1 font-black">404</h1>
			<p className="text-muted">
				{l === "de"
					? "Diese Seite existiert nicht."
					: "This page does not exist."}
			</p>
			<Link to="/$lang" params={{ lang: l }} className="text-sm">
				← {t(l, "nav.back")}
			</Link>
		</main>
	);
}

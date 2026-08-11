import { Link, useLocation } from "@tanstack/react-router";
import { type Lang, languages, t } from "../lib/i18n.ts";

export function NotFoundPage() {
	const { pathname } = useLocation();
	const first = pathname.split("/")[1];
	const lang: Lang = languages.includes(first as Lang) ? (first as Lang) : "de";

	return (
		<main className="mx-auto max-w-3xl px-6 py-10 space-y-10">
			<header className="border-b border-ink pb-2">
				<h1 className="text-h2 font-bold uppercase tracking-[0.1em]">
					{t(lang, "home.title")}
				</h1>
			</header>

			<div className="space-y-4">
				<p className="figures text-figure text-muted">404</p>
				<p className="text-lead">{t(lang, "notfound.heading")}</p>
				<p className="text-body text-muted max-w-prose">
					{t(lang, "notfound.body")}
				</p>
			</div>

			<Link
				to="/$lang"
				params={{ lang }}
				className="inline-block border border-ink px-3 py-1.5 text-meta no-underline hover:bg-ink hover:text-paper transition-colors"
			>
				{t(lang, "notfound.cta")}
			</Link>

			<p className="text-meta text-dimmed border-t border-rule pt-4 max-w-prose">
				{t(lang, "notfound.tip")}
			</p>
		</main>
	);
}

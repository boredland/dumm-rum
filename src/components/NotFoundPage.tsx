import { Link, useLocation } from "@tanstack/react-router";
import { type Lang, languages, t } from "../lib/i18n.ts";

export function NotFoundPage() {
	const { pathname } = useLocation();
	const first = pathname.split("/")[1];
	const lang: Lang = languages.includes(first as Lang) ? (first as Lang) : "de";

	return (
		<main className="mx-auto flex min-h-[80vh] max-w-xl flex-col items-center justify-center gap-6 p-6 text-center">
			<div aria-hidden className="text-[72px] leading-none">
				👻
			</div>
			<div>
				<h1 className="text-display font-black tracking-tight">404</h1>
				<p className="mt-2 text-h2 font-bold text-muted">
					{t(lang, "notfound.heading")}
				</p>
				<p className="mt-1 text-body text-dimmed">
					{t(lang, "notfound.subheading")}
				</p>
			</div>

			<p className="text-body text-muted">{t(lang, "notfound.body")}</p>

			<section className="w-full rounded-xl border border-border-dim bg-surface/60 p-4 text-left">
				<p className="mb-2 text-meta uppercase tracking-wide text-muted">
					{t(lang, "notfound.board.header")}
				</p>
				<div className="flex items-baseline justify-between gap-3 font-mono">
					<span className="tabular-nums text-body text-dimmed">
						{t(lang, "notfound.board.time")}
					</span>
					<span className="text-body font-bold">
						{t(lang, "notfound.board.line")}
					</span>
					<span className="flex-1 truncate text-body text-muted">
						{t(lang, "notfound.board.destination")}
					</span>
					<span className="whitespace-nowrap text-body text-danger">
						👻 {t(lang, "notfound.board.status")}
					</span>
				</div>
			</section>

			<Link
				to="/$lang"
				params={{ lang }}
				className="rounded-full border border-border bg-surface px-4 py-2 text-body font-bold text-fg no-underline transition-colors hover:bg-surface-hover"
			>
				{t(lang, "notfound.cta")}
			</Link>

			<p className="text-meta text-dimmed">{t(lang, "notfound.tip")}</p>
		</main>
	);
}

import { createFileRoute, Link } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { type Lang, t } from "../../lib/i18n.ts";
import {
	getLineSummaries,
	getOperatorSummaries,
	getStopSummaries,
	type LineSummary,
	type OperatorSummary,
	type StopSummary,
} from "../../lib/queries.ts";
import { categoryIcons, slugForStop } from "../../lib/stations.ts";
import { onTimeRate, pct, shortStationName } from "../../lib/utils.ts";

const getHomeSummaries = createServerFn({ method: "GET" }).handler(
	async (): Promise<{
		lines: LineSummary[];
		operators: OperatorSummary[];
		stops: StopSummary[];
	}> => {
		const [lines, operators, stops] = await Promise.all([
			getLineSummaries(),
			getOperatorSummaries(),
			getStopSummaries(),
		]);
		return { lines, operators, stops };
	},
);

export const Route = createFileRoute("/$lang/")({
	loader: async () => await getHomeSummaries(),
	component: Index,
});

function borderForScore(score: number): string {
	if (score < 80) return "border-red-500";
	if (score < 90) return "border-amber-500";
	return "border-emerald-500";
}

function Index() {
	const { lines, operators, stops } = Route.useLoaderData();
	const { lang } = Route.useParams();
	const l = lang as Lang;
	const other: Lang = l === "de" ? "en" : "de";

	return (
		<main className="mx-auto max-w-5xl p-6 space-y-10">
			<header className="space-y-1">
				<h1 className="text-3xl font-bold flex items-center gap-2">
					🚏 {t(l, "home.title")}
				</h1>
				<p className="text-muted text-sm">{t(l, "home.subtitle")}</p>
				<p className="text-sm">
					<Link to="/$lang/map" params={{ lang: l }}>
						{t(l, "map.title")} →
					</Link>
				</p>
			</header>

			<Section
				title={`${t(l, "home.lines")} (${lines.length})`}
				gridClass="grid grid-cols-[repeat(auto-fit,minmax(180px,1fr))] gap-3"
			>
				{[...lines]
					.sort((a, b) => {
						const sa = onTimeRate(a.cancelled, a.delayed, a.total);
						const sb = onTimeRate(b.cancelled, b.delayed, b.total);
						return (
							sa - sb ||
							a.line.localeCompare(b.line, undefined, { numeric: true })
						);
					})
					.map((line) => (
						<LineCard key={line.line} line={line} lang={l} />
					))}
			</Section>

			<Section
				title={`${t(l, "home.stations")} (${stops.length})`}
				gridClass="grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-3"
			>
				{stops.slice(0, 40).map((stop) => (
					<StopCard key={stop.stopName} stop={stop} lang={l} />
				))}
			</Section>

			<Section
				title={`${t(l, "home.operators")} (${operators.length})`}
				gridClass="grid grid-cols-[repeat(auto-fit,minmax(260px,1fr))] gap-3"
			>
				{[...operators]
					.sort((a, b) => {
						const sa = onTimeRate(a.cancelled, a.delayed, a.total);
						const sb = onTimeRate(b.cancelled, b.delayed, b.total);
						return sa - sb || a.operator.localeCompare(b.operator);
					})
					.map((op) => (
						<OperatorCard key={op.operator} op={op} lang={l} />
					))}
			</Section>

			<footer className="pt-8 border-t border-border-dim flex items-center gap-3 text-xs text-dimmed">
				<a href="https://www.rmv.de" className="inline-flex shrink-0">
					<img
						src="/rmv-logo.svg"
						alt="RMV"
						width={74}
						height={15}
						className="opacity-60 hover:opacity-100 transition-opacity"
					/>
				</a>
				<span>{l === "de" ? "Datenquelle: RMV" : "Data source: RMV"}</span>
				<span className="ml-auto">
					<Link to="/$lang" params={{ lang: other }}>
						{other.toUpperCase()}
					</Link>
				</span>
			</footer>
		</main>
	);
}

function Section({
	title,
	gridClass,
	children,
}: {
	title: string;
	gridClass: string;
	children: React.ReactNode;
}) {
	return (
		<details className="group" open>
			<summary className="text-xs uppercase tracking-wide text-muted font-semibold mb-3 cursor-pointer select-none">
				{title}
			</summary>
			<div className={`${gridClass} mt-3`}>{children}</div>
		</details>
	);
}

function LineCard({ line, lang }: { line: LineSummary; lang: Lang }) {
	const score = onTimeRate(line.cancelled, line.delayed, line.total);
	return (
		<Link
			to="/$lang/line/$line"
			params={{ lang, line: line.line }}
			className={`bg-surface border ${borderForScore(score)} rounded-xl p-4 no-underline text-fg hover:bg-surface-hover transition-colors`}
		>
			<div className="text-lg font-bold">
				{categoryIcons([line.category])} {line.line}
			</div>
			<div
				className="text-xs text-muted truncate"
				title={line.destinations.join(" ↔ ")}
			>
				{line.destinations.join(" ↔ ")}
			</div>
			<div className="text-sm text-muted mt-1">
				{pct(line.cancelled, line.total)}% {t(lang, "home.cancelled")}
				{line.ghost > 0 ? ` · ${pct(line.ghost, line.total)}% 👻` : ""}
				{" · "}
				{pct(line.delayed, line.total)}% {t(lang, "home.delayed")}
			</div>
			{line.total > 0 && (
				<div className="text-xs text-muted mt-1">
					{t(lang, "stat.reliability")}: {score}%
				</div>
			)}
		</Link>
	);
}

function StopCard({ stop, lang }: { stop: StopSummary; lang: Lang }) {
	const cancRate =
		stop.journeyCount > 0 ? stop.cancelled / stop.journeyCount : 0;
	const border =
		cancRate > 0.1
			? "border-red-500"
			: cancRate > 0.05
				? "border-amber-500"
				: "border-emerald-500";
	const slug = slugForStop(stop.stopIds, stop.stopName);
	return (
		<Link
			to="/$lang/$station"
			params={{ lang, station: slug }}
			className={`bg-surface border ${border} rounded-xl p-4 no-underline text-fg hover:bg-surface-hover transition-colors`}
		>
			<div className="text-[0.7rem] uppercase tracking-wide text-muted mb-1">
				{categoryIcons(stop.categories)}
			</div>
			<div className="text-base font-semibold">
				{shortStationName(stop.stopName)}
			</div>
			{stop.lines.length > 0 && (
				<div
					className="text-xs text-muted truncate"
					title={stop.lines.join(", ")}
				>
					{stop.lines.join(", ")}
				</div>
			)}
			{stop.journeyCount > 0 ? (
				<div className="text-sm text-muted mt-1">
					{stop.journeyCount} {t(lang, "stat.departures").toLowerCase()} ·{" "}
					{pct(stop.cancelled, stop.journeyCount)}% {t(lang, "home.cancelled")}
				</div>
			) : (
				<div className="text-sm text-dimmed mt-1">
					{t(lang, "table.no_data")}
				</div>
			)}
		</Link>
	);
}

function OperatorCard({ op, lang }: { op: OperatorSummary; lang: Lang }) {
	const score = onTimeRate(op.cancelled, op.delayed, op.total);
	return (
		<Link
			to="/$lang/operator/$operator"
			params={{ lang, operator: op.operator }}
			className={`bg-surface border ${borderForScore(score)} rounded-xl p-4 no-underline text-fg hover:bg-surface-hover transition-colors`}
		>
			<div className="text-[0.7rem] uppercase tracking-wide text-muted mb-1">
				{categoryIcons(op.categories)}
			</div>
			<div className="text-base font-semibold">{op.operator}</div>
			{op.lines.length > 0 && (
				<div
					className="text-xs text-muted truncate"
					title={op.lines.join(", ")}
				>
					{op.lines.join(", ")}
				</div>
			)}
			<div className="text-sm text-muted mt-1">
				{pct(op.cancelled, op.total)}% {t(lang, "home.cancelled")}
				{op.ghost > 0 ? ` · ${pct(op.ghost, op.total)}% 👻` : ""}
				{" · "}
				{pct(op.delayed, op.total)}% {t(lang, "home.delayed")}
			</div>
			{op.total > 0 && (
				<div className="text-xs text-muted mt-1">
					{t(lang, "stat.reliability")}: {score}%
				</div>
			)}
		</Link>
	);
}

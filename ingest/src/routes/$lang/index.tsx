import { createFileRoute, Link } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { useState } from "react";
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

function matchesQuery(q: string, ...fields: string[]): boolean {
	return fields.some((f) => f.toLowerCase().includes(q));
}

function Index() {
	const { lines, operators, stops } = Route.useLoaderData();
	const { lang } = Route.useParams();
	const l = lang as Lang;
	const other: Lang = l === "de" ? "en" : "de";
	const [query, setQuery] = useState("");
	const q = query.toLowerCase().trim();

	const filteredLines = [...lines]
		.filter(
			(line) =>
				!q ||
				matchesQuery(
					q,
					line.line,
					line.category,
					line.operators.join(" "),
					line.destinations.join(" "),
				),
		)
		.sort((a, b) => {
			const sa = onTimeRate(a.cancelled, a.delayed, a.total);
			const sb = onTimeRate(b.cancelled, b.delayed, b.total);
			return (
				sa - sb || a.line.localeCompare(b.line, undefined, { numeric: true })
			);
		});

	const filteredStops = stops.filter(
		(stop) =>
			!q ||
			matchesQuery(
				q,
				shortStationName(stop.stopName),
				stop.stopName,
				stop.lines.join(" "),
			),
	);

	const filteredOps = [...operators]
		.filter((op) => !q || matchesQuery(q, op.operator, op.lines.join(" ")))
		.sort((a, b) => {
			const sa = onTimeRate(a.cancelled, a.delayed, a.total);
			const sb = onTimeRate(b.cancelled, b.delayed, b.total);
			return sa - sb || a.operator.localeCompare(b.operator);
		});

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

			<OverviewCards
				lines={lines}
				stops={stops}
				operators={operators}
				lang={l}
			/>

			<div className="relative">
				<input
					type="search"
					placeholder={t(l, "search.placeholder")}
					value={query}
					onChange={(e) => setQuery(e.target.value)}
					className="w-full bg-surface border border-border rounded-xl px-4 py-2.5 text-sm placeholder:text-muted focus:outline-none focus:border-accent"
				/>
			</div>

			<Section
				title={`${t(l, "home.lines")} (${filteredLines.length})`}
				gridClass="grid grid-cols-[repeat(auto-fit,minmax(180px,1fr))] gap-3"
			>
				{filteredLines.map((line) => (
					<LineCard key={line.line} line={line} lang={l} />
				))}
			</Section>

			<Section
				title={`${t(l, "home.stations")} (${filteredStops.length})`}
				gridClass="grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-3"
			>
				{filteredStops.slice(0, q ? 200 : 40).map((stop) => (
					<StopCard key={stop.stopName} stop={stop} lang={l} />
				))}
			</Section>

			<Section
				title={`${t(l, "home.operators")} (${filteredOps.length})`}
				gridClass="grid grid-cols-[repeat(auto-fit,minmax(260px,1fr))] gap-3"
			>
				{filteredOps.map((op) => (
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

// ─── Overview cards (OTP + worst offenders) ────────────────────────────

type Worst = { name: string; count: number; rate: number };

function findWorst(
	items: { name: string; count: number; total: number }[],
): Worst | null {
	let worst: Worst | null = null;
	for (const item of items) {
		if (item.count === 0) continue;
		const rate = item.total > 0 ? item.count / item.total : 0;
		if (
			!worst ||
			rate > worst.rate ||
			(rate === worst.rate && item.count > worst.count)
		) {
			worst = { name: item.name, count: item.count, rate };
		}
	}
	return worst;
}

function OverviewCards({
	lines,
	stops,
	operators,
	lang,
}: {
	lines: LineSummary[];
	stops: StopSummary[];
	operators: OperatorSummary[];
	lang: Lang;
}) {
	let totalAll = 0;
	let cancelledAll = 0;
	let ghostAll = 0;
	let delayedAll = 0;
	for (const l of lines) {
		totalAll += l.total;
		cancelledAll += l.cancelled;
		ghostAll += l.ghost;
		delayedAll += l.delayed;
	}
	if (totalAll === 0) return null;

	const score = onTimeRate(cancelledAll, delayedAll, totalAll);
	const scoreWithGhosts = onTimeRate(
		cancelledAll + ghostAll,
		delayedAll,
		totalAll,
	);
	const scoreColor =
		score < 80
			? "text-red-500"
			: score < 90
				? "text-amber-500"
				: "text-emerald-500";

	const lineItems = (key: "cancelled" | "ghost" | "delayed") =>
		lines.map((l) => ({ name: l.line, count: l[key], total: l.total }));
	const stopItems = (key: "cancelled" | "ghost" | "delayed") =>
		stops.map((s) => ({
			name: shortStationName(s.stopName),
			count: s[key],
			total: s.journeyCount,
		}));
	const opItems = (key: "cancelled" | "ghost" | "delayed") =>
		operators.map((o) => ({ name: o.operator, count: o[key], total: o.total }));

	return (
		<div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
			<div className="bg-surface border border-border rounded-xl p-5">
				<div className="text-[0.7rem] uppercase tracking-wide text-muted mb-1">
					{t(lang, "home.overall_score")}
				</div>
				<div className={`text-5xl font-bold tabular-nums ${scoreColor}`}>
					{score}
					<span className="text-lg text-muted">%</span>
				</div>
				{ghostAll > 0 && (
					<div className="text-sm text-purple-400 mt-1">
						👻 {scoreWithGhosts}%
					</div>
				)}
				<div className="text-sm text-muted mt-1">
					{totalAll.toLocaleString(lang)}{" "}
					{t(lang, "stat.departures").toLowerCase()}
				</div>
			</div>

			<WorstCard
				title={t(lang, "home.most_cancellations")}
				line={findWorst(lineItems("cancelled"))}
				station={findWorst(stopItems("cancelled"))}
				op={findWorst(opItems("cancelled"))}
				lang={lang}
				color="text-red-500"
			/>
			<WorstCard
				title={t(lang, "home.most_ghosts")}
				line={findWorst(lineItems("ghost"))}
				station={findWorst(stopItems("ghost"))}
				op={findWorst(opItems("ghost"))}
				lang={lang}
				color="text-purple-400"
			/>
			<WorstCard
				title={t(lang, "home.most_delays")}
				line={findWorst(lineItems("delayed"))}
				station={findWorst(stopItems("delayed"))}
				op={findWorst(opItems("delayed"))}
				lang={lang}
				color="text-amber-500"
			/>
		</div>
	);
}

function WorstCard({
	title,
	line,
	station,
	op,
	lang,
	color,
}: {
	title: string;
	line: Worst | null;
	station: Worst | null;
	op: Worst | null;
	lang: Lang;
	color: string;
}) {
	const hasAny =
		(line?.count ?? 0) + (station?.count ?? 0) + (op?.count ?? 0) > 0;
	return (
		<div className="bg-surface border border-border rounded-xl p-5">
			<div className="text-[0.7rem] uppercase tracking-wide text-muted mb-1">
				{title}
			</div>
			{!hasAny && <div className="text-2xl font-bold text-emerald-500">0</div>}
			{line && line.count > 0 && (
				<div className="text-sm mt-1">
					<span className={`${color} font-semibold`}>
						{(line.rate * 100).toFixed(1)}%
					</span>{" "}
					<span className="text-muted">{t(lang, "home.line")}</span>{" "}
					<span className="font-semibold">{line.name}</span>
				</div>
			)}
			{station && station.count > 0 && (
				<div className="text-sm mt-1 truncate" title={station.name}>
					<span className={`${color} font-semibold`}>
						{(station.rate * 100).toFixed(1)}%
					</span>{" "}
					<span className="text-muted">{t(lang, "home.station")}</span>{" "}
					<span className="font-semibold">{station.name}</span>
				</div>
			)}
			{op && op.count > 0 && (
				<div className="text-sm mt-1 truncate" title={op.name}>
					<span className={`${color} font-semibold`}>
						{(op.rate * 100).toFixed(1)}%
					</span>{" "}
					<span className="text-muted">{t(lang, "home.operator")}</span>{" "}
					<span className="font-semibold">{op.name}</span>
				</div>
			)}
		</div>
	);
}

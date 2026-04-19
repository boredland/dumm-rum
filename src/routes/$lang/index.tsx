import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { setResponseHeader } from "@tanstack/react-start/server";
import { useEffect, useRef, useState } from "react";
import { type HomePayload, loadHomeSummaries } from "../../lib/home.ts";
import { type Lang, t } from "../../lib/i18n.ts";
import type {
	DaysFilter,
	LineSummary,
	OperatorSummary,
	StopSummary,
} from "../../lib/queries.ts";
import { Pill, pillClass } from "../../components/Pill.tsx";
import { categoryIcons, slugForStop } from "../../lib/stations.ts";
import { borderForCancRate, borderForScore } from "../../lib/status.ts";
import { onTimeRate, pct, shortStationName } from "../../lib/utils.ts";

const VALID_DAYS = new Set<DaysFilter>([
	"all",
	"today",
	"weekdays",
	"weekends",
]);

const getHomeSummaries = createServerFn({ method: "GET" })
	.inputValidator((days: unknown): DaysFilter => {
		if (typeof days === "string" && VALID_DAYS.has(days as DaysFilter)) {
			return days as DaysFilter;
		}
		return "today";
	})
	.handler(async ({ data: days }): Promise<HomePayload> => {
		// Same cache window as the origin memo's fresh phase — matches
		// `HOME_FRESH_MS` in src/lib/home.ts. SWR extends on top so
		// Cloudflare can keep serving a recent copy during the window
		// where the origin is still warming the next revision.
		setResponseHeader(
			"Cache-Control",
			"public, max-age=30, s-maxage=60, stale-while-revalidate=600",
		);
		return loadHomeSummaries(days);
	});

type SearchParams = { days?: DaysFilter; cat?: string };

const STALE_TIME = 5 * 60 * 1000;

export const Route = createFileRoute("/$lang/")({
	staleTime: STALE_TIME,
	head: () => ({
		meta: [{ title: "DummRum" }],
	}),
	validateSearch: (search: Record<string, unknown>): SearchParams => ({
		days:
			typeof search.days === "string" &&
			VALID_DAYS.has(search.days as DaysFilter)
				? (search.days as DaysFilter)
				: undefined,
		cat: typeof search.cat === "string" ? search.cat : undefined,
	}),
	loaderDeps: ({ search }) => ({ days: search.days }),
	loader: async ({ deps }) =>
		await getHomeSummaries({ data: deps.days ?? "today" }),
	component: Index,
});

function matchesQuery(q: string, ...fields: string[]): boolean {
	return fields.some((f) => f.toLowerCase().includes(q));
}

const DAY_FILTERS: {
	key: DaysFilter;
	labelKey: "days.today" | "days.all" | "days.weekdays" | "days.weekends";
}[] = [
	{ key: "today", labelKey: "days.today" },
	{ key: "all", labelKey: "days.all" },
	{ key: "weekdays", labelKey: "days.weekdays" },
	{ key: "weekends", labelKey: "days.weekends" },
];

const REFETCH_INTERVAL = 5 * 60 * 1000;

function Index() {
	const {
		lines,
		operators,
		stops,
		days: activeDays,
		oldestDate,
	} = Route.useLoaderData();
	const { lang } = Route.useParams();
	const l = lang as Lang;
	const router = useRouter();

	useEffect(() => {
		if (activeDays !== "today") return;
		const id = setInterval(() => router.invalidate(), REFETCH_INTERVAL);
		return () => clearInterval(id);
	}, [activeDays, router]);
	const other: Lang = l === "de" ? "en" : "de";
	const search = Route.useSearch();
	const navigate = Route.useNavigate();
	const [query, setQuery] = useState("");
	const q = query.toLowerCase().trim();
	const catFilter = search.cat ?? "all";
	const setCatFilter = (v: string) =>
		navigate({
			search: (s) => ({ ...s, cat: v === "all" ? undefined : v }),
			replace: true,
		});
	const searchRef = useRef<HTMLInputElement>(null);
	useEffect(() => {
		const handler = (e: KeyboardEvent) => {
			if ((e.ctrlKey || e.metaKey) && e.key === "k") {
				e.preventDefault();
				searchRef.current?.focus();
			}
		};
		document.addEventListener("keydown", handler);
		return () => document.removeEventListener("keydown", handler);
	}, []);
	// Platform-aware shortcut label. Mac uses ⌘K, everyone else Ctrl K.
	// `navigator` is only defined on the client so we hydrate empty and
	// update in an effect, matching the behaviour of similar hints.
	const [shortcutLabel, setShortcutLabel] = useState("Ctrl K");
	useEffect(() => {
		const isMac =
			typeof navigator !== "undefined" &&
			/mac|iphone|ipad|ipod/i.test(navigator.platform || navigator.userAgent);
		if (isMac) setShortcutLabel("⌘ K");
	}, []);
	const [openSections, setOpenSections] = useState<Set<string>>(new Set());
	const toggleSection = (key: string, open: boolean) => {
		setOpenSections((prev) => {
			const next = new Set(prev);
			if (open) next.add(key);
			else next.delete(key);
			return next;
		});
	};

	const matchesCat = (categories: string | string[]) => {
		if (catFilter === "all") return true;
		const cats = Array.isArray(categories) ? categories : [categories];
		const normalize = (c: string): string => {
			if (c === "S") return "S-Bahn";
			if (/bus$/i.test(c) || c === "AST") return "Bus";
			if (/stra(ß|ss)enbahn/i.test(c) || c === "Str") return "Tram";
			return c;
		};
		const normalized = cats.map(normalize);
		if (catFilter === "RE,RB")
			return normalized.some((c) => c === "RE" || c === "RB");
		if (catFilter === "S") return normalized.some((c) => c === "S-Bahn");
		// Long-distance rail — ICE / IC / EC / ECE / NJ / EN / RJ / RJX /
		// TGV / EST all share the "Fernverkehr" filter so users don't
		// need a chip per category.
		if (catFilter === "FV")
			return normalized.some((c) =>
				[
					"ICE",
					"ICE-Sprinter",
					"IC",
					"EC",
					"ECE",
					"NJ",
					"EN",
					"RJ",
					"RJX",
					"TGV",
					"EST",
				].includes(c),
			);
		return normalized.includes(catFilter);
	};

	const filteredLines = [...lines]
		.filter(
			(line) =>
				matchesCat(line.category) &&
				(!q ||
					matchesQuery(
						q,
						line.line,
						line.category,
						line.operators.join(" "),
						line.destinations.join(" "),
					)),
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
			matchesCat(stop.categories) &&
			(!q ||
				matchesQuery(
					q,
					shortStationName(stop.stopName),
					stop.stopName,
					stop.lines.join(" "),
				)),
	);

	const filteredOps = [...operators]
		.filter(
			(op) =>
				matchesCat(op.categories) &&
				(!q || matchesQuery(q, op.operator, op.lines.join(" "))),
		)
		.sort((a, b) => {
			const sa = onTimeRate(a.cancelled, a.delayed, a.total);
			const sb = onTimeRate(b.cancelled, b.delayed, b.total);
			return sa - sb || a.operator.localeCompare(b.operator);
		});

	return (
		<main className="mx-auto max-w-5xl p-6 space-y-10">
			<header className="space-y-1">
				<h1 className="text-h1 font-bold flex items-center gap-2">
					🚏 {t(l, "home.title")}
				</h1>
				<p className="text-muted text-body">
					{t(l, "home.subtitle")}
					{" · "}
					<Link
						to="/$lang/map"
						params={{ lang: l }}
						className="text-accent hover:underline"
					>
						{t(l, "map.link")} →
					</Link>
				</p>
				{oldestDate && (
					<p className="text-meta text-dimmed">
						{t(l, "stat.since")}{" "}
						{new Date(`${oldestDate}T00:00:00`).toLocaleDateString(l, {
							year: "numeric",
							month: "long",
							day: "numeric",
						})}
					</p>
				)}
			</header>

			<details className="group text-body text-muted">
				<summary className="list-none [&::-webkit-details-marker]:hidden inline-flex items-center gap-1.5 cursor-pointer select-none font-medium hover:text-fg transition-colors">
					<svg
						width="10"
						height="10"
						viewBox="0 0 12 12"
						className="transition-transform group-open:rotate-90"
						aria-hidden
					>
						<path
							d="M4 3 L8 6 L4 9"
							fill="none"
							stroke="currentColor"
							strokeWidth="1.5"
							strokeLinecap="round"
							strokeLinejoin="round"
						/>
					</svg>
					{t(l, "home.methodology_title")}
				</summary>
				<ul className="mt-2 list-disc pl-5 space-y-1">
					<li>{t(l, "home.methodology_collection")}</li>
					<li>{t(l, "home.methodology_cancellation")}</li>
					<li>{t(l, "home.methodology_delay")}</li>
					<li>{t(l, "home.methodology_delayed")}</li>
					<li>{t(l, "home.methodology_ghost")}</li>
					<li>{t(l, "home.methodology_reliability")}</li>
					<li>{t(l, "home.methodology_dedup")}</li>
					<li>{t(l, "home.methodology_colors")}</li>
				</ul>
			</details>

			<div className="flex flex-wrap gap-2">
				{DAY_FILTERS.map((f) => (
					<Link
						key={f.key}
						to="/$lang"
						params={{ lang: l }}
						search={f.key === "today" ? {} : { days: f.key }}
						className={pillClass(activeDays === f.key)}
					>
						{t(l, f.labelKey)}
					</Link>
				))}
			</div>

			<div className="flex flex-wrap gap-2">
				{[
					{ key: "all", label: t(l, "filter.all") },
					{ key: "U-Bahn", label: "U-Bahn" },
					{ key: "S", label: "S-Bahn" },
					{ key: "Tram", label: "Tram" },
					{ key: "Bus", label: "Bus" },
					{ key: "RE,RB", label: "RE/RB" },
					{ key: "FV", label: "Fernverkehr" },
				].map((f) => (
					<Pill
						key={f.key}
						active={catFilter === f.key}
						onClick={() => setCatFilter(f.key)}
					>
						{f.label}
					</Pill>
				))}
			</div>

			<OverviewCards
				lines={filteredLines}
				stops={filteredStops}
				operators={filteredOps}
				lang={l}
			/>

			<div className="relative">
				<input
					ref={searchRef}
					type="search"
					placeholder={t(l, "search.placeholder")}
					value={query}
					onChange={(e) => setQuery(e.target.value)}
					className="w-full bg-surface border border-border rounded-xl px-4 py-2.5 pr-14 text-body placeholder:text-muted focus:outline-none focus:border-accent"
				/>
				{query ? (
					<button
						type="button"
						aria-label={l === "de" ? "Suche leeren" : "Clear search"}
						onClick={() => {
							setQuery("");
							searchRef.current?.focus();
						}}
						className="absolute right-3 top-1/2 -translate-y-1/2 inline-flex h-6 w-6 items-center justify-center rounded-full text-muted hover:bg-surface-hover hover:text-fg transition-colors cursor-pointer"
					>
						<svg
							width="12"
							height="12"
							viewBox="0 0 12 12"
							fill="none"
							stroke="currentColor"
							strokeWidth="1.5"
							strokeLinecap="round"
							aria-hidden
						>
							<path d="M3 3 L9 9 M9 3 L3 9" />
						</svg>
					</button>
				) : (
					<kbd className="hidden sm:inline-flex absolute right-3 top-1/2 -translate-y-1/2 text-meta text-dimmed bg-surface-hover border border-border-dim rounded px-1.5 py-0.5 pointer-events-none">
						{shortcutLabel}
					</kbd>
				)}
			</div>

			<Section
				title={`${t(l, "home.lines")} (${filteredLines.length})`}
				gridClass="grid grid-cols-[repeat(auto-fit,minmax(180px,1fr))] gap-3"
				open={openSections.has("lines") || (!!q && filteredLines.length > 0)}
				onToggle={(open) => toggleSection("lines", open)}
			>
				{filteredLines.map((line) => (
					<LineCard key={line.line} line={line} lang={l} />
				))}
			</Section>

			<Section
				title={`${t(l, "home.stations")} (${filteredStops.length})`}
				gridClass="grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-3"
				open={openSections.has("stops") || (!!q && filteredStops.length > 0)}
				onToggle={(open) => toggleSection("stops", open)}
			>
				{filteredStops.slice(0, q ? 200 : 40).map((stop) => (
					<StopCard key={stop.stopName} stop={stop} lang={l} />
				))}
			</Section>

			<Section
				title={`${t(l, "home.operators")} (${filteredOps.length})`}
				gridClass="grid grid-cols-[repeat(auto-fit,minmax(260px,1fr))] gap-3"
				open={openSections.has("operators") || (!!q && filteredOps.length > 0)}
				onToggle={(open) => toggleSection("operators", open)}
			>
				{filteredOps.map((op) => (
					<OperatorCard key={op.operator} op={op} lang={l} />
				))}
			</Section>

			<footer className="pt-8 border-t border-border-dim flex flex-wrap items-center gap-x-4 gap-y-2 text-meta text-dimmed">
				<div className="flex items-center gap-3">
					<a href="https://www.rmv.de" className="inline-flex shrink-0">
						<img
							src="/rmv-logo.svg"
							alt="RMV"
							width={74}
							height={15}
							className="grayscale hover:grayscale-0 transition-[filter]"
						/>
					</a>
					<span>{l === "de" ? "Datenquelle: RMV" : "Data source: RMV"}</span>
				</div>
				<div className="flex items-center gap-3">
					<a
						href="https://github.com/boredland/dumm-rum"
						className="text-dimmed hover:text-fg transition-colors"
					>
						{t(l, "nav.github")}
					</a>
					<a
						href="https://github.com/boredland/dumm-rum/issues/new"
						target="_blank"
						rel="noopener noreferrer"
						className="text-dimmed hover:text-fg transition-colors"
					>
						{t(l, "nav.report_bug")}
					</a>
				</div>
				<Link
					to="/$lang"
					params={{ lang: other }}
					className="ml-auto text-dimmed hover:text-fg transition-colors"
				>
					{other.toUpperCase()}
				</Link>
			</footer>
		</main>
	);
}

function Section({
	title,
	gridClass,
	open,
	onToggle,
	children,
}: {
	title: string;
	gridClass: string;
	open: boolean;
	onToggle: (open: boolean) => void;
	children: React.ReactNode;
}) {
	return (
		<details
			className="group"
			open={open}
			onToggle={(e) => onToggle((e.target as HTMLDetailsElement).open)}
		>
			<summary className="list-none [&::-webkit-details-marker]:hidden flex items-center gap-1.5 text-meta uppercase text-muted font-semibold mb-3 cursor-pointer select-none hover:text-fg transition-colors">
				<svg
					width="10"
					height="10"
					viewBox="0 0 12 12"
					className="transition-transform group-open:rotate-90"
					aria-hidden
				>
					<path
						d="M4 3 L8 6 L4 9"
						fill="none"
						stroke="currentColor"
						strokeWidth="1.5"
						strokeLinecap="round"
						strokeLinejoin="round"
					/>
				</svg>
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
			className={`bg-surface border ${borderForScore(score)} rounded-xl p-4 no-underline text-fg hover:bg-surface-hover active:scale-[0.99] transition-all`}
		>
			<div className="text-lg font-bold">
				{categoryIcons([line.category])} {line.line}
			</div>
			<div
				className="text-meta text-muted truncate"
				title={line.destinations.join(" ↔ ")}
			>
				{line.destinations.join(" ↔ ")}
			</div>
			<div className="text-body text-muted mt-1">
				{pct(line.cancelled, line.total)}% {t(lang, "home.cancelled")}
				{line.ghost > 0 ? ` · ${pct(line.ghost, line.total)}% 👻` : ""}
				{" · "}
				{pct(line.delayed, line.total)}% {t(lang, "home.delayed")}
			</div>
			{line.total > 0 && (
				<div className="text-meta text-muted mt-1">
					{t(lang, "stat.reliability")}: {score}%
				</div>
			)}
		</Link>
	);
}

function StopCard({ stop, lang }: { stop: StopSummary; lang: Lang }) {
	const cancRate =
		stop.journeyCount > 0 ? stop.cancelled / stop.journeyCount : 0;
	const border = borderForCancRate(cancRate);
	const slug = slugForStop(stop.stopIds, stop.stopName);
	return (
		<Link
			to="/$lang/$station"
			params={{ lang, station: slug }}
			className={`bg-surface border ${border} rounded-xl p-4 no-underline text-fg hover:bg-surface-hover active:scale-[0.99] transition-all`}
		>
			<div className="text-meta uppercase text-muted mb-1">
				{categoryIcons(stop.categories)}
			</div>
			<div className="text-lg font-semibold">
				{shortStationName(stop.stopName)}
			</div>
			{stop.lines.length > 0 && (
				<div
					className="text-meta text-muted truncate"
					title={stop.lines.join(", ")}
				>
					{stop.lines.join(", ")}
				</div>
			)}
			{stop.journeyCount > 0 ? (
				<div className="text-body text-muted mt-1">
					{stop.journeyCount} {t(lang, "stat.departures").toLowerCase()} ·{" "}
					{pct(stop.cancelled, stop.journeyCount)}% {t(lang, "home.cancelled")}
				</div>
			) : (
				<div className="text-body text-dimmed mt-1">
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
			className={`bg-surface border ${borderForScore(score)} rounded-xl p-4 no-underline text-fg hover:bg-surface-hover active:scale-[0.99] transition-all`}
		>
			<div className="text-meta uppercase text-muted mb-1">
				{categoryIcons(op.categories)}
			</div>
			<div className="text-lg font-semibold">{op.operator}</div>
			{op.lines.length > 0 && (
				<div
					className="text-meta text-muted truncate"
					title={op.lines.join(", ")}
				>
					{op.lines.join(", ")}
				</div>
			)}
			<div className="text-body text-muted mt-1">
				{pct(op.cancelled, op.total)}% {t(lang, "home.cancelled")}
				{op.ghost > 0 ? ` · ${pct(op.ghost, op.total)}% 👻` : ""}
				{" · "}
				{pct(op.delayed, op.total)}% {t(lang, "home.delayed")}
			</div>
			{op.total > 0 && (
				<div className="text-meta text-muted mt-1">
					{t(lang, "stat.reliability")}: {score}%
				</div>
			)}
		</Link>
	);
}

// ─── Overview cards (OTP + worst offenders) ────────────────────────────

type Worst = { name: string; slug: string; count: number; rate: number };

// Tiny samples dominate a pure count/total ranking (1-of-1 cancelled = 100%),
// so require a floor before an entry qualifies. Most long-distance trains run
// 5–10 services through Frankfurt per day, so 10 covers nearly everything a
// user would recognise while excluding first-run noise.
const WORST_MIN_SAMPLE = 10;

function findWorst(
	items: { name: string; slug: string; count: number; total: number }[],
): Worst | null {
	let worst: Worst | null = null;
	for (const item of items) {
		if (item.count === 0) continue;
		if (item.total < WORST_MIN_SAMPLE) continue;
		if (!item.name || !item.slug) continue;
		const rate = item.count / item.total;
		if (
			!worst ||
			rate > worst.rate ||
			(rate === worst.rate && item.count > worst.count)
		) {
			worst = { name: item.name, slug: item.slug, count: item.count, rate };
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
		score < 80 ? "text-danger" : score < 90 ? "text-warn" : "text-ok";

	const lineItems = (key: "cancelled" | "ghost" | "delayed") =>
		lines.map((l) => ({
			name: l.line,
			slug: l.line,
			count: l[key],
			total: l.total,
		}));
	const stopItems = (key: "cancelled" | "ghost" | "delayed") =>
		stops.map((s) => ({
			name: shortStationName(s.stopName),
			slug: slugForStop(s.stopIds, s.stopName),
			count: s[key],
			total: s.journeyCount,
		}));
	const opItems = (key: "cancelled" | "ghost" | "delayed") =>
		operators.map((o) => ({
			name: o.operator,
			slug: o.operator,
			count: o[key],
			total: o.total,
		}));

	return (
		<div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
			<div className="bg-surface border border-border rounded-xl p-5">
				<div className="text-meta uppercase text-muted mb-1">
					{t(lang, "home.overall_score")}
				</div>
				<div
					className={`text-h1 sm:text-display font-bold tabular-nums ${scoreColor}`}
				>
					{score}
					<span className="text-lg text-muted">%</span>
				</div>
				{ghostAll > 0 && (
					<div className="text-body text-info mt-1">
						👻 {scoreWithGhosts}%
					</div>
				)}
				<div className="text-body text-muted mt-1">
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
				color="text-danger"
			/>
			<WorstCard
				title={t(lang, "home.most_ghosts")}
				line={findWorst(lineItems("ghost"))}
				station={findWorst(stopItems("ghost"))}
				op={findWorst(opItems("ghost"))}
				lang={lang}
				color="text-info"
			/>
			<WorstCard
				title={t(lang, "home.most_delays")}
				line={findWorst(lineItems("delayed"))}
				station={findWorst(stopItems("delayed"))}
				op={findWorst(opItems("delayed"))}
				lang={lang}
				color="text-warn"
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
			<div className="text-meta uppercase text-muted mb-1">
				{title}
			</div>
			{!hasAny && <div className="text-h2 font-bold text-ok">0</div>}
			{line && line.count > 0 && (
				<Link
					to="/$lang/line/$line"
					params={{ lang, line: line.slug }}
					className="block text-body mt-1 no-underline text-fg hover:text-accent transition-colors"
				>
					<span className={`${color} font-semibold`}>
						{(line.rate * 100).toFixed(1)}%
					</span>{" "}
					<span className="text-muted">{t(lang, "home.line")}</span>{" "}
					<span className="font-semibold">{line.name}</span>
				</Link>
			)}
			{station && station.count > 0 && (
				<Link
					to="/$lang/$station"
					params={{ lang, station: station.slug }}
					className="block text-body mt-1 no-underline text-fg hover:text-accent transition-colors line-clamp-2"
					title={station.name}
				>
					<span className={`${color} font-semibold`}>
						{(station.rate * 100).toFixed(1)}%
					</span>{" "}
					<span className="text-muted">{t(lang, "home.station")}</span>{" "}
					<span className="font-semibold">{station.name}</span>
				</Link>
			)}
			{op && op.count > 0 && (
				<Link
					to="/$lang/operator/$operator"
					params={{ lang, operator: op.slug }}
					className="block text-body mt-1 no-underline text-fg hover:text-accent transition-colors line-clamp-2"
					title={op.name}
				>
					<span className={`${color} font-semibold`}>
						{(op.rate * 100).toFixed(1)}%
					</span>{" "}
					<span className="text-muted">{t(lang, "home.operator")}</span>{" "}
					<span className="font-semibold">{op.name}</span>
				</Link>
			)}
		</div>
	);
}

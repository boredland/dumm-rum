import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { setResponseHeader } from "@tanstack/react-start/server";
import { useEffect, useRef, useState } from "react";
import { FilterGroup } from "../../components/FilterGroup.tsx";
import { type HomePayload, loadHomeSummaries } from "../../lib/home.ts";
import { type Lang, t } from "../../lib/i18n.ts";
import type {
	DaysFilter,
	LineSummary,
	OperatorSummary,
	StopSummary,
} from "../../lib/queries.ts";
import { categoryIcons, slugForStop } from "../../lib/stations.ts";
import {
	onTimeRate,
	shortStationName,
	yesterdayBerlin,
} from "../../lib/utils.ts";

const VALID_DAYS = new Set<DaysFilter>([
	"all",
	"today",
	"weekdays",
	"weekends",
]);

interface HomeSummariesInput {
	days: DaysFilter;
	until?: string;
}

const isValidIsoDate = (str: string): boolean => {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(str)) return false;
	const date = new Date(str);
	return !Number.isNaN(date.getTime());
};

const getHomeSummaries = createServerFn({ method: "GET" })
	.inputValidator((input: unknown): HomeSummariesInput => {
		if (typeof input === "object" && input !== null && "days" in input) {
			const days = (input as Record<string, unknown>).days;
			const until = (input as Record<string, unknown>).until;
			if (typeof days === "string" && VALID_DAYS.has(days as DaysFilter)) {
				return {
					days: days as DaysFilter,
					until:
						typeof until === "string" && isValidIsoDate(until)
							? until
							: undefined,
				};
			}
		}
		return { days: "today" };
	})
	.handler(async ({ data }): Promise<HomePayload> => {
		// For non-"today" queries, use yesterday as the "until" date for cacheability
		const until =
			data.days !== "today" ? (data.until ?? yesterdayBerlin()) : undefined;

		// For "today", use default cache (changes at midnight)
		// For date-based queries, extend cache duration since the result won't change
		if (data.days !== "today") {
			setResponseHeader(
				"Cache-Control",
				"public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800",
			);
		} else {
			setResponseHeader(
				"Cache-Control",
				"public, max-age=30, s-maxage=60, stale-while-revalidate=600",
			);
		}

		return loadHomeSummaries(data.days, until);
	});

type SearchParams = { days?: DaysFilter; cat?: string[] };

const STALE_TIME = 5 * 60 * 1000;

/** Filter keys used to be UI shorthands rather than bucket names. Shared
 * and bookmarked `?cat=` URLs still carry them, so translate on read. */
const LEGACY_CAT_KEYS: Record<string, string> = {
	S: "S-Bahn",
	"RE,RB": "Regionalverkehr",
};

function parseCatFilter(input: unknown): string[] | undefined {
	const raw = typeof input === "string" ? [input] : input;
	if (!Array.isArray(raw)) return undefined;
	const cats = raw
		.filter((c): c is string => typeof c === "string" && c.length > 0)
		.map((c) => LEGACY_CAT_KEYS[c] ?? c);
	return cats.length > 0 ? cats : undefined;
}

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
		cat: parseCatFilter(search.cat),
	}),
	loaderDeps: ({ search }) => ({ days: search.days }),
	loader: async ({ deps }) =>
		await getHomeSummaries({ data: { days: deps.days ?? "today" } }),
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

/** Keys are the buckets `normalize_category` emits, so a filter is a
 * plain equality check — no client-side normalization to drift. */
const CATEGORY_OPTIONS: Array<{ key: string; label: string }> = [
	{ key: "U-Bahn", label: "U-Bahn" },
	{ key: "S-Bahn", label: "S-Bahn" },
	{ key: "Tram", label: "Tram" },
	{ key: "Bus", label: "Bus" },
	{ key: "Regionalverkehr", label: "RE/RB" },
];

function matchesCategoryFilters(
	selectedFilters: string[],
	categories: string | string[],
): boolean {
	if (selectedFilters.length === 0) return true;
	const cats = Array.isArray(categories) ? categories : [categories];
	return selectedFilters.some((filter) => cats.includes(filter));
}

function categoriesForActiveFilter(
	categories: string[],
	selectedFilters: string[],
): string[] {
	if (selectedFilters.length === 0) return categories;
	const filteredCategories = categories.filter((category) =>
		matchesCategoryFilters(selectedFilters, category),
	);
	return filteredCategories.length > 0 ? filteredCategories : categories;
}

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
	const catFilter = search.cat ?? [];
	const toggleCatFilter = (key: string) => {
		navigate({
			search: (s) => {
				const current = s.cat ?? [];
				const next = Array.isArray(current) ? current : [];
				if (next.includes(key)) {
					// Remove category
					const filtered = next.filter((c) => c !== key);
					return { ...s, cat: filtered.length > 0 ? filtered : undefined };
				} else {
					// Add category
					return { ...s, cat: [...next, key] };
				}
			},
			replace: true,
		});
	};
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

	const filteredLines = [...lines]
		.filter(
			(line) =>
				matchesCategoryFilters(catFilter, line.category) &&
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
			matchesCategoryFilters(catFilter, stop.categories) &&
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
				matchesCategoryFilters(catFilter, op.categories) &&
				(!q || matchesQuery(q, op.operator, op.lines.join(" "))),
		)
		.sort((a, b) => {
			const sa = onTimeRate(a.cancelled, a.delayed, a.total);
			const sb = onTimeRate(b.cancelled, b.delayed, b.total);
			return sa - sb || a.operator.localeCompare(b.operator);
		});
	const sectionTitle = (label: string, filtered: number, total: number) =>
		filtered !== total
			? `${label} (${filtered}/${total})`
			: `${label} (${filtered})`;

	return (
		<div className="min-h-screen bg-bg">
			<main className="mx-auto max-w-5xl p-6 space-y-8">
				<header className="flex flex-wrap items-end justify-between gap-x-6 gap-y-2">
					<div>
						<h1 className="text-h1 font-black tracking-tighter">
							{t(l, "home.title")}
						</h1>
						<p className="text-muted text-body">{t(l, "home.subtitle")}</p>
					</div>
					{oldestDate && (
						<p className="text-meta text-dimmed tabular-nums">
							{t(l, "stat.since")}{" "}
							<time className="text-fg/70">
								{new Date(`${oldestDate}T00:00:00`).toLocaleDateString(l, {
									year: "numeric",
									month: "long",
									day: "numeric",
								})}
							</time>
						</p>
					)}
				</header>

				<div className="relative">
					<input
						ref={searchRef}
						type="search"
						placeholder={t(l, "search.placeholder")}
						value={query}
						onChange={(e) => setQuery(e.target.value)}
						className="w-full bg-transparent border-b border-border focus:border-fg px-0 py-3 text-lg placeholder:text-muted/60 focus:outline-none transition-colors"
					/>
					{query ? (
						<button
							type="button"
							aria-label={l === "de" ? "Suche leeren" : "Clear search"}
							onClick={() => {
								setQuery("");
								searchRef.current?.focus();
							}}
							className="absolute right-0 top-1/2 -translate-y-1/2 inline-flex h-8 w-8 items-center justify-center text-muted hover:text-fg transition-colors"
						>
							✕
						</button>
					) : (
						<kbd className="hidden sm:inline-flex absolute right-0 top-1/2 -translate-y-1/2 text-micro font-bold uppercase text-dimmed border border-border-dim rounded-sm px-1.5 py-0.5 pointer-events-none">
							{shortcutLabel}
						</kbd>
					)}
				</div>

				<div className="flex flex-wrap items-center gap-x-6 gap-y-3">
					<FilterGroup
						options={DAY_FILTERS.map((f) => ({
							key: f.key,
							label: t(l, f.labelKey),
						}))}
						selected={activeDays}
						linkProps={(key) => ({
							to: "/$lang",
							params: { lang: l },
							search: (prev) => ({
								...prev,
								days: key === "today" ? undefined : key,
							}),
						})}
					/>
					<div className="hidden sm:block h-6 w-px bg-border" />
					<FilterGroup
						options={CATEGORY_OPTIONS}
						selected={catFilter}
						onToggle={toggleCatFilter}
						showClearButton={catFilter.length > 0}
						clearLabel={t(l, "filter.all")}
						onClear={() =>
							navigate({
								search: (s) => ({ ...s, cat: undefined }),
								replace: true,
							})
						}
					/>
				</div>

				<OverviewCards
					lines={filteredLines}
					stops={filteredStops}
					operators={filteredOps}
					lang={l}
				/>

				<details className="group text-meta text-muted -mt-2">
					<summary className="list-none [&::-webkit-details-marker]:hidden inline-flex items-center gap-2 cursor-pointer select-none hover:text-fg transition-colors">
						<span className="text-dimmed group-open:rotate-90 transition-transform inline-block w-3">
							›
						</span>
						<span className="signage-label">
							{t(l, "home.methodology_title")}
						</span>
					</summary>
					<ul className="mt-3 ml-5 list-none space-y-1.5 border-l border-border pl-4 max-w-2xl">
						{[
							"collection",
							"cancellation",
							"delayed",
							"ghost",
							"reliability",
							"dedup",
							"colors",
						].map((key) => {
							const translationKey = `home.methodology_${key}` as
								| "home.methodology_collection"
								| "home.methodology_cancellation"
								| "home.methodology_delayed"
								| "home.methodology_ghost"
								| "home.methodology_reliability"
								| "home.methodology_dedup"
								| "home.methodology_colors";
							return (
								<li key={key} className="text-meta leading-relaxed">
									{t(l, translationKey)}
								</li>
							);
						})}
					</ul>
				</details>

				<Section
					title={sectionTitle(
						t(l, "home.lines"),
						filteredLines.length,
						lines.length,
					)}
					gridClass="grid grid-cols-[repeat(auto-fit,minmax(180px,1fr))] gap-3"
					open={openSections.has("lines") || (!!q && filteredLines.length > 0)}
					onToggle={(open) => toggleSection("lines", open)}
				>
					{filteredLines.map((line) => (
						<LineCard key={line.line} line={line} lang={l} />
					))}
				</Section>

				<Section
					title={sectionTitle(
						t(l, "home.stations"),
						filteredStops.length,
						stops.length,
					)}
					gridClass="grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-3"
					open={openSections.has("stops") || (!!q && filteredStops.length > 0)}
					onToggle={(open) => toggleSection("stops", open)}
				>
					{filteredStops.slice(0, q ? 200 : 40).map((stop) => (
						<StopCard
							key={stop.stopName}
							stop={stop}
							lang={l}
							activeFilters={catFilter}
						/>
					))}
				</Section>

				<Section
					title={sectionTitle(
						t(l, "home.operators"),
						filteredOps.length,
						operators.length,
					)}
					gridClass="grid grid-cols-[repeat(auto-fit,minmax(260px,1fr))] gap-3"
					open={
						openSections.has("operators") || (!!q && filteredOps.length > 0)
					}
					onToggle={(open) => toggleSection("operators", open)}
				>
					{filteredOps.map((op) => (
						<OperatorCard
							key={op.operator}
							op={op}
							lang={l}
							activeFilters={catFilter}
						/>
					))}
				</Section>

				<footer className="mt-8 pt-6 border-t border-border flex flex-wrap items-center gap-x-6 gap-y-3 text-meta text-muted">
					<a
						href="https://www.rmv.de"
						className="inline-flex items-center gap-2 hover:text-fg transition-colors"
					>
						<img
							src="/rmv-logo.svg"
							alt="RMV"
							width={56}
							height={11}
							className="grayscale opacity-60 group-hover:opacity-100"
						/>
						<span>{l === "de" ? "Datenquelle: RMV" : "Data source: RMV"}</span>
					</a>
					<a
						href="https://github.com/boredland/dumm-rum"
						className="hover:text-fg transition-colors"
					>
						{t(l, "nav.github")}
					</a>
					<a
						href="https://github.com/boredland/dumm-rum/issues/new"
						target="_blank"
						rel="noopener noreferrer"
						className="hover:text-fg transition-colors"
					>
						{t(l, "nav.report_bug")}
					</a>
					<Link
						to="/$lang"
						params={{ lang: other }}
						className="ml-auto signage-label hover:text-fg transition-colors"
					>
						{other.toUpperCase()} →
					</Link>
				</footer>
			</main>
		</div>
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
			<summary className="list-none [&::-webkit-details-marker]:hidden flex items-baseline gap-3 mb-4 cursor-pointer select-none">
				<span className="text-dimmed group-open:rotate-90 transition-transform inline-block w-3">
					›
				</span>
				<span className="signage-label text-fg">{title}</span>
				<div className="h-px bg-border flex-1" />
			</summary>
			<div className={gridClass}>{children}</div>
		</details>
	);
}

/** Quiet aggregate card. The card type (line/station/operator) is conveyed by
 * the section heading above; the reliability percent is the only numeric
 * anchor — colour-coded so the label is implicit. */
function AggregateCard({
	to,
	params,
	score,
	icon,
	name,
	subtitle,
	subtitleTitle,
}: {
	to: "/$lang/line/$line" | "/$lang/$station" | "/$lang/operator/$operator";
	params: Record<string, string>;
	score: number;
	icon?: React.ReactNode;
	name: string;
	subtitle: string;
	subtitleTitle?: string;
}) {
	const tone =
		score < 80 ? "text-danger" : score < 90 ? "text-warn" : "text-ok";
	return (
		<Link
			// biome-ignore lint/suspicious/noExplicitAny: route is union-typed
			to={to as any}
			// biome-ignore lint/suspicious/noExplicitAny: params shape varies per route
			params={params as any}
			className="card no-underline group p-3 hover:border-fg/40 hover:bg-surface-hover transition-colors flex flex-col gap-1"
		>
			<div className="flex items-start justify-between gap-2">
				<div className="text-body font-bold text-fg leading-tight tracking-tight truncate">
					{name}
				</div>
				<span className={`text-body font-black tabular-nums ${tone}`}>
					{score}%
				</span>
			</div>
			<div
				className="text-meta text-muted truncate flex items-center gap-1.5"
				title={subtitleTitle ?? subtitle}
			>
				{icon && (
					<span className="text-dimmed shrink-0 inline-flex">{icon}</span>
				)}
				<span className="truncate">{subtitle}</span>
			</div>
		</Link>
	);
}

function LineCard({ line, lang }: { line: LineSummary; lang: Lang }) {
	const score = onTimeRate(line.cancelled, line.delayed, line.total);
	return (
		<AggregateCard
			to="/$lang/line/$line"
			params={{ lang, line: line.slug }}
			score={score}
			icon={categoryIcons([line.category])}
			name={line.line}
			subtitle={line.destinations.join(" ↔ ")}
			subtitleTitle={line.destinations.join(" ↔ ")}
		/>
	);
}

function StopCard({
	stop,
	lang,
	activeFilters,
}: {
	stop: StopSummary;
	lang: Lang;
	activeFilters: string[];
}) {
	const cancRate =
		stop.journeyCount > 0 ? stop.cancelled / stop.journeyCount : 0;
	const slug = slugForStop(stop.stopIds, stop.stopName);
	const score = Math.round((1 - cancRate) * 100);
	const visibleCategories = categoriesForActiveFilter(
		stop.categories,
		activeFilters,
	);
	return (
		<AggregateCard
			to="/$lang/$station"
			params={{ lang, station: slug }}
			score={score}
			icon={categoryIcons(visibleCategories)}
			name={shortStationName(stop.stopName)}
			subtitle={stop.lines.join(" · ")}
		/>
	);
}

function OperatorCard({
	op,
	lang,
	activeFilters,
}: {
	op: OperatorSummary;
	lang: Lang;
	activeFilters: string[];
}) {
	const score = onTimeRate(op.cancelled, op.delayed, op.total);
	const visibleCategories = categoriesForActiveFilter(
		op.categories,
		activeFilters,
	);
	return (
		<AggregateCard
			to="/$lang/operator/$operator"
			params={{ lang, operator: op.operator }}
			score={score}
			icon={categoryIcons(visibleCategories)}
			name={op.operator}
			subtitle={op.lines.join(" · ")}
		/>
	);
}

type Worst = { name: string; slug: string; count: number; rate: number };
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
		score < 80
			? "led-text-danger"
			: score < 90
				? "led-text-warn"
				: "led-text-ok";

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
		<div className="grid grid-cols-1 sm:grid-cols-4 gap-4">
			<div className="sm:col-span-1 signage-frame p-2 flex flex-col">
				<div className="flex justify-between items-center mb-1 px-1">
					<span className="signage-label !text-white/30">
						{t(lang, "board.status_monitor")}
					</span>
					<div className="w-1.5 h-1.5 rounded-full bg-green-500/40 animate-pulse" />
				</div>
				<div className="led-display flex-1 flex flex-col justify-center py-4">
					<div className="signage-label !text-white/40 text-center mb-2">
						{t(lang, "home.overall_score")}
					</div>
					<div
						className={`text-display font-black text-center tabular-nums ${scoreColor}`}
					>
						{score}
						<span className="text-h2 opacity-50">%</span>
					</div>
					{ghostAll > 0 && (
						<div className="signage-label !text-info text-center mt-3 border-t border-white/10 pt-2 mx-4">
							{scoreWithGhosts}% reliability incl. ghosts
						</div>
					)}
				</div>
				<div className="signage-label !text-white/40 text-center mt-2 py-1 bg-black/20 rounded-sm">
					{totalAll.toLocaleString(lang)} {t(lang, "board.tracked")}
				</div>
			</div>

			<div className="sm:col-span-3 grid grid-cols-1 sm:grid-cols-3 gap-4">
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
		<div className="card p-3 hover:border-fg/40 transition-colors">
			<div className="signage-label mb-3">{title}</div>
			{!hasAny && (
				<div className="text-h2 font-black text-ok/30 tabular-nums">0.0%</div>
			)}
			<div className="space-y-2.5">
				{line && line.count > 0 && (
					<WorstRow
						to="/$lang/line/$line"
						params={{ lang, line: line.slug }}
						label={t(lang, "home.line")}
						name={line.name}
						rate={line.rate}
						color={color}
					/>
				)}
				{station && station.count > 0 && (
					<WorstRow
						to="/$lang/$station"
						params={{ lang, station: station.slug }}
						label={t(lang, "home.station")}
						name={station.name}
						rate={station.rate}
						color={color}
					/>
				)}
				{op && op.count > 0 && (
					<WorstRow
						to="/$lang/operator/$operator"
						params={{ lang, operator: op.slug }}
						label={t(lang, "home.operator")}
						name={op.name}
						rate={op.rate}
						color={color}
					/>
				)}
			</div>
		</div>
	);
}

function WorstRow({
	to,
	params,
	label,
	name,
	rate,
	color,
}: {
	to: "/$lang/line/$line" | "/$lang/$station" | "/$lang/operator/$operator";
	params: Record<string, string>;
	label: string;
	name: string;
	rate: number;
	color: string;
}) {
	return (
		<Link
			// biome-ignore lint/suspicious/noExplicitAny: route is union-typed
			to={to as any}
			// biome-ignore lint/suspicious/noExplicitAny: params shape varies per route
			params={params as any}
			className="block no-underline group"
		>
			<div className="text-micro text-dimmed uppercase tracking-wider group-hover:text-muted transition-colors">
				{label}
			</div>
			<div className="flex items-baseline justify-between gap-2">
				<span className="text-body font-bold text-fg truncate">{name}</span>
				<span className={`${color} text-body font-black tabular-nums shrink-0`}>
					{(rate * 100).toFixed(1)}%
				</span>
			</div>
		</Link>
	);
}

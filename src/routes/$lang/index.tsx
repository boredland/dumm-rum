import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { setResponseHeader } from "@tanstack/react-start/server";
import { useEffect, useRef, useState } from "react";
import { FilterGroup } from "../../components/FilterGroup.tsx";
import { type HomePayload, loadHomeSummaries } from "../../lib/home.ts";
import { type Lang, langFromParams, t, tParts } from "../../lib/i18n.ts";
import type {
	DaysFilter,
	LineSummary,
	OperatorSummary,
	StopSummary,
} from "../../lib/queries.ts";
import { pageHead } from "../../lib/seo.ts";
import { slugForStop } from "../../lib/stations.ts";
import { toneForCount, toneForScore } from "../../lib/status.ts";
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
		return { days: "all" };
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
		await getHomeSummaries({ data: { days: deps.days ?? "all" } }),
	head: ({ params }) => {
		const l = langFromParams(params);
		return {
			...pageHead({
				lang: l,
				title: t(l, "seo.home.title"),
				description: t(l, "seo.home.description"),
				route: "",
			}),
		};
	},
	component: Index,
});

function matchesQuery(q: string, ...fields: string[]): boolean {
	return fields.some((f) => f.toLowerCase().includes(q));
}

const DAY_FILTERS: {
	key: DaysFilter;
	labelKey: "days.today" | "days.all" | "days.weekdays" | "days.weekends";
}[] = [
	{ key: "all", labelKey: "days.all" },
	{ key: "today", labelKey: "days.today" },
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
					const filtered = next.filter((c) => c !== key);
					return { ...s, cat: filtered.length > 0 ? filtered : undefined };
				}
				return { ...s, cat: [...next, key] };
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

	return (
		<div className="min-h-screen">
			<main className="mx-auto max-w-3xl px-6 py-10 space-y-12">
				<Masthead lang={l} oldestDate={oldestDate} activeDays={activeDays} />

				<Finding lines={filteredLines} lang={l} />

				<div className="space-y-5">
					<div className="relative border-b border-rule focus-within:border-ink transition-colors">
						<input
							ref={searchRef}
							type="search"
							placeholder={t(l, "search.placeholder")}
							value={query}
							onChange={(e) => setQuery(e.target.value)}
							className="w-full bg-transparent px-0 py-2 text-body placeholder:text-dimmed focus:outline-none [&::-webkit-search-cancel-button]:hidden"
						/>
						{query ? (
							<button
								type="button"
								aria-label={l === "de" ? "Suche leeren" : "Clear search"}
								onClick={() => {
									setQuery("");
									searchRef.current?.focus();
								}}
								className="absolute right-0 top-1/2 -translate-y-1/2 text-meta text-muted hover:text-ink"
							>
								✕
							</button>
						) : (
							<kbd className="hidden sm:block absolute right-0 top-1/2 -translate-y-1/2 text-micro text-dimmed pointer-events-none">
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
									days: key === "all" ? undefined : key,
								}),
							})}
						/>
						<span className="hidden sm:block h-4 w-px bg-rule" />
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
				</div>

				<Notables
					lines={filteredLines}
					stops={filteredStops}
					operators={filteredOps}
					lang={l}
				/>

				<Section
					title={t(l, "home.lines")}
					shown={filteredLines.length}
					total={lines.length}
					open={openSections.has("lines") || (!!q && filteredLines.length > 0)}
					onToggle={(open) => toggleSection("lines", open)}
				>
					<RankTable
						lang={l}
						nameHeader={t(l, "home.line")}
						rows={filteredLines.map((line) => ({
							key: line.line,
							name: line.line,
							detail: line.destinations.join(" – "),
							total: line.total,
							cancelled: line.cancelled,
							ghost: line.ghost,
							delayed: line.delayed,
							to: "/$lang/line/$line",
							params: { lang: l, line: line.slug },
						}))}
					/>
				</Section>

				<Section
					title={t(l, "home.stations")}
					shown={filteredStops.length}
					total={stops.length}
					open={openSections.has("stops") || (!!q && filteredStops.length > 0)}
					onToggle={(open) => toggleSection("stops", open)}
				>
					<RankTable
						lang={l}
						nameHeader={t(l, "home.station")}
						rows={filteredStops.slice(0, q ? 200 : 40).map((stop) => ({
							key: stop.stopName,
							name: shortStationName(stop.stopName),
							detail: stop.lines.join(" · "),
							total: stop.journeyCount,
							cancelled: stop.cancelled,
							ghost: stop.ghost,
							delayed: stop.delayed,
							to: "/$lang/$station",
							params: {
								lang: l,
								station: slugForStop(stop.stopIds, stop.stopName),
							},
						}))}
					/>
				</Section>

				<Section
					title={t(l, "home.operators")}
					shown={filteredOps.length}
					total={operators.length}
					open={
						openSections.has("operators") || (!!q && filteredOps.length > 0)
					}
					onToggle={(open) => toggleSection("operators", open)}
				>
					<RankTable
						lang={l}
						nameHeader={t(l, "home.operator")}
						rows={filteredOps.map((op) => ({
							key: op.operator,
							name: op.operator,
							detail: op.lines.join(" · "),
							total: op.total,
							cancelled: op.cancelled,
							ghost: op.ghost,
							delayed: op.delayed,
							to: "/$lang/operator/$operator",
							params: { lang: l, operator: op.operator },
						}))}
					/>
				</Section>

				<Method lang={l} />

				<footer className="border-t border-rule pt-6 flex flex-wrap items-center gap-x-6 gap-y-2 text-meta text-muted">
					<a href="https://www.rmv.de" className="hover:text-ink">
						{l === "de" ? "Datenquelle: RMV" : "Data source: RMV"}
					</a>
					<a
						href="https://github.com/boredland/dumm-rum"
						className="hover:text-ink"
					>
						{t(l, "nav.github")}
					</a>
					<a
						href="https://github.com/boredland/dumm-rum/issues/new"
						target="_blank"
						rel="noopener noreferrer"
						className="hover:text-ink"
					>
						{t(l, "nav.report_bug")}
					</a>
					<Link
						to="/$lang"
						params={{ lang: other }}
						className="ml-auto hover:text-ink"
					>
						{other.toUpperCase()}
					</Link>
				</footer>
			</main>
		</div>
	);
}

function Masthead({
	lang,
	oldestDate,
	activeDays,
}: {
	lang: Lang;
	oldestDate: string | null;
	activeDays: DaysFilter;
}) {
	const window =
		activeDays === "today"
			? t(lang, "home.window_today")
			: t(lang, "home.window_range");
	return (
		<header className="space-y-2">
			<div className="flex items-baseline justify-between gap-4 border-b border-ink pb-2">
				<h1 className="text-h2 font-bold uppercase tracking-[0.1em] text-ink">
					{t(lang, "home.title")}
				</h1>
				<p className="text-micro uppercase tracking-[0.08em] text-muted">
					{window}
				</p>
			</div>
			<div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 text-meta text-muted">
				<p>
					{t(lang, "home.subtitle")}
					{" · "}
					<Link
						to="/$lang/map"
						params={{ lang }}
						className="text-accent underline decoration-rule"
					>
						{t(lang, "map.link")}
					</Link>
				</p>
				{oldestDate && (
					<p>
						{t(lang, "stat.since")}{" "}
						<time className="figures">
							{new Date(`${oldestDate}T00:00:00`).toLocaleDateString(lang, {
								year: "numeric",
								month: "long",
								day: "numeric",
							})}
						</time>
					</p>
				)}
			</div>
		</header>
	);
}

/** The signature: the report's conclusion, set as a sentence at display
 * size with the figures carrying the verdict colour. A page whose whole
 * job is answering "did the service run?" should answer it in words
 * before it shows a single table. */
function Finding({ lines, lang }: { lines: LineSummary[]; lang: Lang }) {
	let total = 0;
	let cancelled = 0;
	let ghost = 0;
	let delayed = 0;
	for (const line of lines) {
		total += line.total;
		cancelled += line.cancelled;
		ghost += line.ghost;
		delayed += line.delayed;
	}
	if (total === 0) return null;

	const score = onTimeRate(cancelled, delayed, total);
	const withGhosts = onTimeRate(cancelled + ghost, delayed, total);
	const values: Record<string, string> = {
		total: total.toLocaleString(lang),
		rate: `${score}%`,
	};

	return (
		<section className="space-y-4">
			<p className="text-figure text-balance">
				{tParts(lang, "home.finding").map((part, i) =>
					typeof part === "string" ? (
						// biome-ignore lint/suspicious/noArrayIndexKey: fixed sentence structure
						<span key={i}>{part}</span>
					) : (
						<span
							// biome-ignore lint/suspicious/noArrayIndexKey: fixed sentence structure
							key={i}
							className={`figures ${part.param === "rate" ? toneForScore(score) : ""}`}
						>
							{values[part.param]}
						</span>
					),
				)}
			</p>
			{ghost > 0 && (
				<p className="text-meta text-muted">
					{t(lang, "home.finding_ghosts", { rate: `${withGhosts}%` })}
				</p>
			)}
		</section>
	);
}

function Section({
	title,
	shown,
	total,
	open,
	onToggle,
	children,
}: {
	title: string;
	shown: number;
	total: number;
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
			<summary className="list-none [&::-webkit-details-marker]:hidden flex items-baseline gap-3 cursor-pointer select-none border-b border-ink pb-2">
				<span className="eyebrow text-ink">{title}</span>
				<span className="figures text-micro text-muted">
					{shown === total ? total : `${shown}/${total}`}
				</span>
				<span className="ml-auto text-micro text-muted group-open:hidden">
					+
				</span>
				<span className="ml-auto text-micro text-muted hidden group-open:block">
					−
				</span>
			</summary>
			<div className="pt-2">{children}</div>
		</details>
	);
}

interface RankRow {
	key: string;
	name: string;
	detail: string;
	total: number;
	cancelled: number;
	ghost: number;
	delayed: number;
	to: "/$lang/line/$line" | "/$lang/$station" | "/$lang/operator/$operator";
	params: Record<string, string>;
}

/** One table per entity type, sorted worst-first by the parent. Cards gave
 * every row the same weight and hid the counts behind a single percentage;
 * a table lets a reader compare down a column and see what the rate is
 * made of. */
function RankTable({
	lang,
	nameHeader,
	rows,
}: {
	lang: Lang;
	nameHeader: string;
	rows: RankRow[];
}) {
	return (
		<>
			{/* Six numeric columns don't fit a phone: the name truncates to
			   nothing and the reliability column — the one the ranking is
			   built on — falls off the right edge. Stack instead, leading
			   with the score. */}
			<ul className="sm:hidden divide-y divide-rule-dim">
				{rows.map((row) => {
					const score = onTimeRate(row.cancelled, row.delayed, row.total);
					return (
						<li key={row.key}>
							<Link
								// biome-ignore lint/suspicious/noExplicitAny: route is union-typed
								to={row.to as any}
								// biome-ignore lint/suspicious/noExplicitAny: params shape varies per route
								params={row.params as any}
								className="block py-3 no-underline"
							>
								<div className="flex items-baseline justify-between gap-3">
									<span className="truncate">{row.name}</span>
									<span className={`figures shrink-0 ${toneForScore(score)}`}>
										{score}%
									</span>
								</div>
								{row.detail && (
									<p className="truncate text-meta text-muted">{row.detail}</p>
								)}
								<p className="figures text-meta text-dimmed">
									{row.total} · {t(lang, "table.th.cancelled")} {row.cancelled}{" "}
									· {t(lang, "table.th.ghost")} {row.ghost} ·{" "}
									{t(lang, "table.th.delayed")} {row.delayed}
								</p>
							</Link>
						</li>
					);
				})}
			</ul>

			<div className="hidden sm:block">
				<table className="report-table">
					<thead>
						<tr>
							<th>{nameHeader}</th>
							<th className="num">{t(lang, "table.th.total")}</th>
							<th className="num">{t(lang, "table.th.cancelled")}</th>
							<th className="num">{t(lang, "table.th.ghost")}</th>
							<th className="num">{t(lang, "table.th.delayed")}</th>
							<th className="num">{t(lang, "table.otp")}</th>
						</tr>
					</thead>
					<tbody>
						{rows.map((row) => {
							const score = onTimeRate(row.cancelled, row.delayed, row.total);
							return (
								<tr key={row.key}>
									<td className="max-w-0 w-full">
										<Link
											// biome-ignore lint/suspicious/noExplicitAny: route is union-typed
											to={row.to as any}
											// biome-ignore lint/suspicious/noExplicitAny: params shape varies per route
											params={row.params as any}
											className="block no-underline hover:underline"
										>
											<span className="block truncate">{row.name}</span>
											{row.detail && (
												<span
													className="block truncate text-meta text-muted"
													title={row.detail}
												>
													{row.detail}
												</span>
											)}
										</Link>
									</td>
									<td className="num text-muted">{row.total}</td>
									<td className={`num ${toneForCount(row.cancelled, "bad")}`}>
										{row.cancelled || "—"}
									</td>
									<td className={`num ${toneForCount(row.ghost, "ghost")}`}>
										{row.ghost || "—"}
									</td>
									<td className={`num ${toneForCount(row.delayed, "mixed")}`}>
										{row.delayed || "—"}
									</td>
									<td className={`num ${toneForScore(score)}`}>{score}%</td>
								</tr>
							);
						})}
					</tbody>
				</table>
			</div>
		</>
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

/** The outliers, as a single table read across: each row is one measure,
 * each column one kind of entity. Three separate cards forced the reader
 * to re-learn the same layout three times. */
function Notables({
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
	const lineItems = (key: "cancelled" | "ghost" | "delayed") =>
		lines.map((l) => ({
			name: l.line,
			slug: l.slug,
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

	const measures = [
		{
			key: "cancelled" as const,
			label: t(lang, "home.most_cancellations"),
			tone: "text-bad",
		},
		{
			key: "ghost" as const,
			label: t(lang, "home.most_ghosts"),
			tone: "text-ghost",
		},
		{
			key: "delayed" as const,
			label: t(lang, "home.most_delays"),
			tone: "text-mixed",
		},
	];

	const rows = measures.map((m) => ({
		...m,
		line: findWorst(lineItems(m.key)),
		station: findWorst(stopItems(m.key)),
		op: findWorst(opItems(m.key)),
	}));
	if (!rows.some((r) => r.line || r.station || r.op)) return null;

	return (
		<section className="space-y-2">
			<h2 className="eyebrow text-ink border-b border-ink pb-2">
				{t(lang, "home.worst_heading")}
			</h2>
			{/* Phones can't hold a four-column matrix without either
			   truncating the names to uselessness or scrolling sideways,
			   so each measure becomes its own labelled block. */}
			<div className="sm:hidden divide-y divide-rule-dim">
				{rows.map((row) => (
					<div key={row.key} className="py-3 space-y-2">
						<p className="text-micro uppercase tracking-[0.08em] text-muted">
							{row.label}
						</p>
						<dl className="space-y-1">
							<WorstLine
								label={t(lang, "home.line")}
								worst={row.line}
								tone={row.tone}
								to="/$lang/line/$line"
								paramKey="line"
								lang={lang}
							/>
							<WorstLine
								label={t(lang, "home.station")}
								worst={row.station}
								tone={row.tone}
								to="/$lang/$station"
								paramKey="station"
								lang={lang}
							/>
							<WorstLine
								label={t(lang, "home.operator")}
								worst={row.op}
								tone={row.tone}
								to="/$lang/operator/$operator"
								paramKey="operator"
								lang={lang}
							/>
						</dl>
					</div>
				))}
			</div>

			{/* Fixed layout is load-bearing: with the default `auto`, a long
			   station or operator name widens the table past the section
			   rule and the truncation below never engages. */}
			<div className="hidden sm:block">
				<table className="report-table table-fixed">
					<colgroup>
						<col className="w-[27%]" />
						<col className="w-[11%]" />
						<col className="w-[32%]" />
						<col className="w-[30%]" />
					</colgroup>
					<thead>
						<tr>
							<th />
							<th>{t(lang, "home.line")}</th>
							<th>{t(lang, "home.station")}</th>
							<th>{t(lang, "home.operator")}</th>
						</tr>
					</thead>
					<tbody>
						{rows.map((row) => (
							<tr key={row.key}>
								<th
									scope="row"
									className="text-muted font-normal normal-case pr-4 align-top"
								>
									{row.label}
								</th>
								<WorstCell
									worst={row.line}
									tone={row.tone}
									to="/$lang/line/$line"
									paramKey="line"
									lang={lang}
								/>
								<WorstCell
									worst={row.station}
									tone={row.tone}
									to="/$lang/$station"
									paramKey="station"
									lang={lang}
								/>
								<WorstCell
									worst={row.op}
									tone={row.tone}
									to="/$lang/operator/$operator"
									paramKey="operator"
									lang={lang}
								/>
							</tr>
						))}
					</tbody>
				</table>
			</div>
		</section>
	);
}

function WorstLine({
	label,
	worst,
	tone,
	to,
	paramKey,
	lang,
}: {
	label: string;
	worst: Worst | null;
	tone: string;
	to: "/$lang/line/$line" | "/$lang/$station" | "/$lang/operator/$operator";
	paramKey: "line" | "station" | "operator";
	lang: Lang;
}) {
	if (!worst) return null;
	return (
		<div className="flex items-baseline gap-3">
			<dt className="text-meta text-dimmed w-20 shrink-0">{label}</dt>
			<dd className="flex-1 min-w-0 flex items-baseline justify-between gap-3">
				<Link
					// biome-ignore lint/suspicious/noExplicitAny: route is union-typed
					to={to as any}
					// biome-ignore lint/suspicious/noExplicitAny: params shape varies per route
					params={{ lang, [paramKey]: worst.slug } as any}
					className="truncate no-underline hover:underline"
				>
					{worst.name}
				</Link>
				<span className={`figures text-meta shrink-0 ${tone}`}>
					{(worst.rate * 100).toFixed(1)}%
				</span>
			</dd>
		</div>
	);
}

function WorstCell({
	worst,
	tone,
	to,
	paramKey,
	lang,
}: {
	worst: Worst | null;
	tone: string;
	to: "/$lang/line/$line" | "/$lang/$station" | "/$lang/operator/$operator";
	paramKey: "line" | "station" | "operator";
	lang: Lang;
}) {
	if (!worst) return <td className="text-dimmed">—</td>;
	return (
		<td>
			<Link
				// biome-ignore lint/suspicious/noExplicitAny: route is union-typed
				to={to as any}
				// biome-ignore lint/suspicious/noExplicitAny: params shape varies per route
				params={{ lang, [paramKey]: worst.slug } as any}
				className="block no-underline hover:underline"
			>
				<span className="block truncate" title={worst.name}>
					{worst.name}
				</span>
				<span className={`figures block text-meta ${tone}`}>
					{(worst.rate * 100).toFixed(1)}%
				</span>
			</Link>
		</td>
	);
}

/** Method note. A report states how it measured; keeping it collapsed at
 * the foot rather than under the headline means it's available without
 * competing with the finding. */
function Method({ lang }: { lang: Lang }) {
	const keys = [
		"collection",
		"cancellation",
		"delayed",
		"ghost",
		"reliability",
		"dedup",
		"colors",
	] as const;
	return (
		<details className="group border-t border-rule pt-4">
			<summary className="list-none [&::-webkit-details-marker]:hidden flex items-baseline gap-2 cursor-pointer select-none text-meta text-muted hover:text-ink">
				<span className="eyebrow">{t(lang, "home.methodology_title")}</span>
				<span className="text-micro group-open:hidden">+</span>
				<span className="text-micro hidden group-open:block">−</span>
			</summary>
			{/* A list, not a sequence: these are definitions of the terms the
			   report uses, so they carry no step numbers. */}
			<ul className="mt-4 space-y-3 text-meta text-muted max-w-prose">
				{keys.map((key) => (
					<li key={key}>
						{t(lang, `home.methodology_${key}` as `home.methodology_ghost`)}
					</li>
				))}
			</ul>
		</details>
	);
}

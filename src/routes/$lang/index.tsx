import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { setResponseHeader } from "@tanstack/react-start/server";
import { useEffect, useRef, useState } from "react";
import { Pill, pillClass } from "../../components/Pill.tsx";
import { type HomePayload, loadHomeSummaries } from "../../lib/home.ts";
import { type Lang, t } from "../../lib/i18n.ts";
import type {
	DaysFilter,
	LineSummary,
	OperatorSummary,
	StopSummary,
} from "../../lib/queries.ts";
import { categoryIcons, slugForStop } from "../../lib/stations.ts";
import { onTimeRate, shortStationName, yesterdayBerlin } from "../../lib/utils.ts";

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
	return !isNaN(date.getTime());
};

const getHomeSummaries = createServerFn({ method: "GET" })
	.inputValidator((input: unknown): HomeSummariesInput => {
		if (typeof input === "object" && input !== null && "days" in input) {
			const days = (input as Record<string, unknown>).days;
			const until = (input as Record<string, unknown>).until;
			if (typeof days === "string" && VALID_DAYS.has(days as DaysFilter)) {
				return {
					days: days as DaysFilter,
					until: typeof until === "string" && isValidIsoDate(until) ? until : undefined,
				};
			}
		}
		return { days: "today" };
	})
	.handler(async ({ data }): Promise<HomePayload> => {
		// For non-"today" queries, use yesterday as the "until" date for cacheability
		const until =
			data.days !== "today" ? data.until ?? yesterdayBerlin() : undefined;

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

export const Route = createFileRoute("/$lang/")({
	staleTime: STALE_TIME,
	head: () => ({
		meta: [{ title: "DummRum" }],
	}),
	validateSearch: (search: Record<string, unknown>): SearchParams => {
		let cats: string[] | undefined;
		if (Array.isArray(search.cat)) {
			cats = search.cat.filter((c): c is string => typeof c === "string");
			if (cats.length === 0) cats = undefined;
		} else if (typeof search.cat === "string") {
			cats = [search.cat];
		}
		return {
			days:
				typeof search.days === "string" &&
				VALID_DAYS.has(search.days as DaysFilter)
					? (search.days as DaysFilter)
					: undefined,
			cat: cats,
		};
	},
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
					return { ...s, cat: next.filter((c) => c !== key) || undefined };
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

	const matchesCat = (categories: string | string[]) => {
		// If no filter is selected, show all categories
		if (catFilter.length === 0) return true;
		const cats = Array.isArray(categories) ? categories : [categories];
		const normalize = (c: string): string => {
			if (c === "S") return "S-Bahn";
			if (/bus$/i.test(c) || c === "AST") return "Bus";
			if (/stra(ß|ss)enbahn/i.test(c) || c === "Str") return "Tram";
			return c;
		};
		const normalized = cats.map(normalize);
		return catFilter.some((filter) => {
			if (filter === "RE,RB")
				return normalized.some((c) => c === "RE" || c === "RB");
			if (filter === "S") return normalized.some((c) => c === "S-Bahn");
			if (filter === "FV")
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
			return normalized.includes(filter);
		});
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
		<div className="min-h-screen bg-bg">
			<main className="mx-auto max-w-5xl p-6 space-y-10">
				<header className="space-y-1">
					<h1 className="text-h1 font-black flex items-center gap-2 tracking-tighter">
						🚏 {t(l, "home.title")}
					</h1>
					<p className="text-muted text-body font-bold">
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
						<p className="text-micro text-dimmed uppercase font-black tracking-widest">
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
					<summary className="list-none [&::-webkit-details-marker]:hidden inline-flex items-center gap-1.5 cursor-pointer select-none font-bold hover:text-fg transition-colors uppercase text-xs tracking-wider">
						<div className="w-4 h-4 bg-muted/20 flex items-center justify-center rounded-sm group-open:rotate-90 transition-transform">
							▶
						</div>
						{t(l, "home.methodology_title")}
					</summary>
					<ul className="mt-4 list-none pl-6 space-y-2 border-l-2 border-border/30">
						{[
							"collection",
							"cancellation",
							"delay",
							"delayed",
							"ghost",
							"reliability",
							"dedup",
							"colors",
						].map((key) => {
							const translationKey = `home.methodology_${key}` as
								| "home.methodology_collection"
								| "home.methodology_cancellation"
								| "home.methodology_delay"
								| "home.methodology_delayed"
								| "home.methodology_ghost"
								| "home.methodology_reliability"
								| "home.methodology_dedup"
								| "home.methodology_colors";
							return (
								<li key={key} className="text-xs leading-relaxed">
									{t(l, translationKey)}
								</li>
							);
						})}
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
						{ key: "U-Bahn", label: "U-Bahn" },
						{ key: "S", label: "S-Bahn" },
						{ key: "Tram", label: "Tram" },
						{ key: "Bus", label: "Bus" },
						{ key: "RE,RB", label: "RE/RB" },
						{ key: "FV", label: "Fernverkehr" },
					].map((f) => (
						<Pill
							key={f.key}
							active={catFilter.includes(f.key)}
							onClick={() => toggleCatFilter(f.key)}
						>
							{f.label}
						</Pill>
					))}
					{catFilter.length > 0 && (
						<Pill
							active={false}
							onClick={() =>
								navigate({
									search: (s) => ({ ...s, cat: undefined }),
									replace: true,
								})
							}
						>
							{t(l, "filter.all")}
						</Pill>
					)}
				</div>

				<OverviewCards
					lines={filteredLines}
					stops={filteredStops}
					operators={filteredOps}
					lang={l}
				/>

				<div className="relative">
					<div className="absolute left-4 top-1/2 -translate-y-1/2 text-muted/40 pointer-events-none">
						🔍
					</div>
					<input
						ref={searchRef}
						type="search"
						placeholder={t(l, "search.placeholder")}
						value={query}
						onChange={(e) => setQuery(e.target.value)}
						className="w-full bg-surface border-2 border-border/50 rounded-sm px-10 py-3 text-body font-bold placeholder:text-muted/40 focus:outline-none focus:border-accent transition-colors"
					/>
					{query ? (
						<button
							type="button"
							aria-label={l === "de" ? "Suche leeren" : "Clear search"}
							onClick={() => {
								setQuery("");
								searchRef.current?.focus();
							}}
							className="absolute right-3 top-1/2 -translate-y-1/2 inline-flex h-8 w-8 items-center justify-center rounded-sm text-muted hover:bg-surface-hover hover:text-fg transition-colors cursor-pointer"
						>
							✕
						</button>
					) : (
						<kbd className="hidden sm:inline-flex absolute right-3 top-1/2 -translate-y-1/2 text-micro font-black uppercase text-dimmed bg-surface-hover border border-border-dim rounded-sm px-2 py-1 pointer-events-none">
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
					open={
						openSections.has("operators") || (!!q && filteredOps.length > 0)
					}
					onToggle={(open) => toggleSection("operators", open)}
				>
					{filteredOps.map((op) => (
						<OperatorCard key={op.operator} op={op} lang={l} />
					))}
				</Section>

				<footer className="pt-12 border-t-4 border-black flex flex-wrap items-center gap-x-8 gap-y-4 text-micro font-black uppercase tracking-widest text-dimmed">
					<div className="flex items-center gap-4 bg-surface px-4 py-2 rounded-sm border border-border/50">
						<a href="https://www.rmv.de" className="inline-flex shrink-0">
							<img
								src="/rmv-logo.svg"
								alt="RMV"
								width={74}
								height={15}
								className="grayscale hover:grayscale-0 transition-[filter] opacity-50 hover:opacity-100"
							/>
						</a>
						<span className="border-l border-border/50 pl-4">
							{l === "de" ? "Datenquelle: RMV" : "Data source: RMV"}
						</span>
					</div>
					<div className="flex items-center gap-6">
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
					</div>
					<Link
						to="/$lang"
						params={{ lang: other }}
						className="ml-auto bg-signage text-white px-3 py-1.5 rounded-sm hover:opacity-80 transition-opacity border border-white/5 font-black text-micro"
					>
						{other.toUpperCase()}
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
			<summary className="list-none [&::-webkit-details-marker]:hidden flex items-center gap-2 text-xs uppercase font-black text-fg mb-4 cursor-pointer select-none">
				<div className="w-5 h-5 bg-signage text-white flex items-center justify-center text-micro font-black group-open:rotate-90 transition-transform rounded-sm border border-white/5">
					▶
				</div>
				{title}
				<div className="h-0.5 bg-border flex-1 ml-3 opacity-30" />
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
			params={{ lang, line: line.slug }}
			className="signage-frame overflow-hidden no-underline group active:translate-y-px transition-[transform,box-shadow] duration-150 ease-out hover:shadow-[inset_0_0_0_1px_rgba(253,185,19,0.35)]"
		>
			<div className="bg-signage px-3 py-1.5 flex justify-between items-center border-b border-black/40">
				<div className="text-white/90 text-micro font-black uppercase tracking-[0.2em]">
					{line.slug.split(":")[0]} · {line.category}
				</div>
				<div className="text-white/30 scale-75">
					{categoryIcons([line.category])}
				</div>
			</div>
			<div className="p-3 bg-surface/30">
				<div className="text-sm font-black text-fg mb-1 leading-tight tracking-tight">
					{line.line}
				</div>
				<div
					className="text-micro font-bold text-muted/40 uppercase truncate mb-4"
					title={line.destinations.join(" ↔ ")}
				>
					{line.destinations.join(" ↔ ")}
				</div>
				<div className="flex justify-between items-center border-t border-black/5 pt-2">
					<span className="text-micro font-black text-muted/30 uppercase tracking-widest">
						{t(lang, "board.reliability_index")}
					</span>
					<span
						className={`text-xs font-black tabular-nums ${score < 90 ? "text-danger" : "text-ok"}`}
					>
						{score}%
					</span>
				</div>
			</div>
		</Link>
	);
}

function StopCard({ stop, lang }: { stop: StopSummary; lang: Lang }) {
	const cancRate =
		stop.journeyCount > 0 ? stop.cancelled / stop.journeyCount : 0;
	const slug = slugForStop(stop.stopIds, stop.stopName);
	const score = ((1 - cancRate) * 100).toFixed(0);
	return (
		<Link
			to="/$lang/$station"
			params={{ lang, station: slug }}
			className="signage-frame overflow-hidden no-underline group active:translate-y-px transition-[transform,box-shadow] duration-150 ease-out hover:shadow-[inset_0_0_0_1px_rgba(253,185,19,0.35)]"
		>
			<div className="bg-signage px-3 py-1.5 flex justify-between items-center border-b border-black/40">
				<div className="text-white/90 text-micro font-black uppercase tracking-[0.2em]">
					{t(lang, "board.station_label")}
				</div>
				<div className="text-white/30 scale-75">
					{categoryIcons(stop.categories)}
				</div>
			</div>
			<div className="p-3 bg-surface/30">
				<div className="text-sm font-black text-fg mb-1 leading-tight tracking-tight">
					{shortStationName(stop.stopName)}
				</div>
				<div className="text-micro font-bold text-muted/40 uppercase truncate mb-4">
					{stop.lines.join(" · ")}
				</div>
				<div className="flex justify-between items-center border-t border-black/5 pt-2">
					<span className="text-micro font-black text-muted/30 uppercase tracking-widest">
						{t(lang, "board.reliability_index")}
					</span>
					<span
						className={`text-xs font-black tabular-nums ${Number(score) < 90 ? "text-danger" : "text-ok"}`}
					>
						{score}%
					</span>
				</div>
			</div>
		</Link>
	);
}

function OperatorCard({ op, lang }: { op: OperatorSummary; lang: Lang }) {
	const score = onTimeRate(op.cancelled, op.delayed, op.total);
	return (
		<Link
			to="/$lang/operator/$operator"
			params={{ lang, operator: op.operator }}
			className="signage-frame overflow-hidden no-underline group active:translate-y-px transition-[transform,box-shadow] duration-150 ease-out hover:shadow-[inset_0_0_0_1px_rgba(253,185,19,0.35)]"
		>
			<div className="bg-signage px-3 py-1.5 flex justify-between items-center border-b border-black/40">
				<div className="text-white/90 text-micro font-black uppercase tracking-[0.2em]">
					{t(lang, "board.operator_label")}
				</div>
				<div className="flex gap-0.5 scale-75 origin-right opacity-30">
					{op.categories.slice(0, 3).map((c) => (
						<span
							key={c}
							className="w-3 h-3 bg-white text-black flex items-center justify-center text-micro font-black rounded-full"
						>
							{c[0]}
						</span>
					))}
				</div>
			</div>
			<div className="p-3 bg-surface/30">
				<div className="text-sm font-black text-fg mb-1 leading-tight tracking-tight">
					{op.operator}
				</div>
				<div className="text-micro font-bold text-muted/40 uppercase truncate mb-4">
					{op.lines.join(" · ")}
				</div>
				<div className="flex justify-between items-center border-t border-black/5 pt-2">
					<span className="text-micro font-black text-muted/30 uppercase tracking-widest">
						{t(lang, "board.reliability_index")}
					</span>
					<span
						className={`text-xs font-black tabular-nums ${score < 90 ? "text-danger" : "text-ok"}`}
					>
						{score}%
					</span>
				</div>
			</div>
		</Link>
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
					<span className="text-micro font-black text-white/20 uppercase tracking-tighter">
						{t(lang, "board.status_monitor")}
					</span>
					<div className="w-1.5 h-1.5 rounded-full bg-green-500/30 animate-pulse" />
				</div>
				<div className="led-display flex-1 flex flex-col justify-center py-4">
					<div className="text-micro uppercase font-black text-muted/60 tracking-widest text-center mb-2">
						{t(lang, "home.overall_score")}
					</div>
					<div
						className={`text-display font-black text-center tabular-nums ${scoreColor}`}
					>
						{score}
						<span className="text-h2 opacity-50">%</span>
					</div>
					{ghostAll > 0 && (
						<div className="text-micro text-info text-center mt-3 font-black uppercase tracking-widest border-t border-white/10 pt-2 mx-4">
							👻 {scoreWithGhosts}% Reliability
						</div>
					)}
				</div>
				<div className="text-micro text-center text-muted/40 uppercase font-black mt-2 py-1 bg-black/20 rounded-sm">
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
		<div className="signage-frame p-3 hover:border-muted/50 transition-colors">
			<div className="text-micro uppercase font-black text-muted/50 mb-3 border-b border-white/5 pb-1 flex items-center gap-2">
				<div className="w-1 h-1 bg-white/20 rounded-full" /> {title}
			</div>
			{!hasAny && (
				<div className="text-h2 font-black text-ok/30 tabular-nums">0.0%</div>
			)}
			<div className="space-y-3">
				{line && line.count > 0 && (
					<Link
						to="/$lang/line/$line"
						params={{ lang, line: line.slug }}
						className="block no-underline group"
					>
						<div className="flex items-baseline justify-between">
							<span className="text-xs font-black text-fg truncate flex-1 mr-2">
								{line.name}
							</span>
							<span className={`${color} text-sm font-black tabular-nums`}>
								{(line.rate * 100).toFixed(1)}%
							</span>
						</div>
						<div className="text-micro uppercase font-bold text-muted/40 group-hover:text-muted/80 transition-colors">
							{t(lang, "home.line")}
						</div>
					</Link>
				)}
				{station && station.count > 0 && (
					<Link
						to="/$lang/$station"
						params={{ lang, station: station.slug }}
						className="block no-underline group"
					>
						<div className="flex items-baseline justify-between">
							<span className="text-xs font-black text-fg truncate flex-1 mr-2">
								{station.name}
							</span>
							<span className={`${color} text-sm font-black tabular-nums`}>
								{(station.rate * 100).toFixed(1)}%
							</span>
						</div>
						<div className="text-micro uppercase font-bold text-muted/40 group-hover:text-muted/80 transition-colors">
							{t(lang, "home.station")}
						</div>
					</Link>
				)}
				{op && op.count > 0 && (
					<Link
						to="/$lang/operator/$operator"
						params={{ lang, operator: op.slug }}
						className="block no-underline group"
					>
						<div className="flex items-baseline justify-between">
							<span className="text-xs font-black text-fg truncate flex-1 mr-2">
								{op.name}
							</span>
							<span className={`${color} text-sm font-black tabular-nums`}>
								{(op.rate * 100).toFixed(1)}%
							</span>
						</div>
						<div className="text-micro uppercase font-bold text-muted/40 group-hover:text-muted/80 transition-colors">
							{t(lang, "home.operator")}
						</div>
					</Link>
				)}
			</div>
		</div>
	);
}

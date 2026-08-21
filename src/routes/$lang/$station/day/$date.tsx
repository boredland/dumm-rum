import { createFileRoute, Link } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { setResponseHeader } from "@tanstack/react-start/server";
import {
	DepartureFilterBar,
	useDepartureFilters,
} from "../../../../components/DepartureFilters.tsx";
import { StatusMark } from "../../../../components/DepartureRow.tsx";
import { EmptyState } from "../../../../components/EmptyState.tsx";
import { BackLink, PageHeader } from "../../../../components/PageHeader.tsx";
import { type Lang, langFromParams, t } from "../../../../lib/i18n.ts";
import {
	findStopBySlug,
	getStopDayDepartures,
	type StopDayDeparture,
} from "../../../../lib/queries.ts";
import { urlFilter, urlStringFilter } from "../../../../lib/search-state.ts";
import { entityRoute, pageHead } from "../../../../lib/seo.ts";
import { makeSwr } from "../../../../lib/swr.ts";
import {
	delayMin,
	formatTime,
	parseLineSlug,
	prettyDate,
	shortStationName,
	todayBerlin,
} from "../../../../lib/utils.ts";

const STATUS_OPTS = ["all", "issues", "on_time"] as const;
const HOURS_OPTS = ["all", "core"] as const;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

interface DayData {
	stopName: string;
	categories: string[];
	date: string;
	departures: StopDayDeparture[];
}

const stationDaySwr = makeSwr<DayData | null>(
	async (key) => {
		const [slug, date] = key.split("|");
		const stop = await findStopBySlug(slug);
		if (!stop) return null;
		const departures = await getStopDayDepartures(stop.stopIds, date);
		// The line slugs already carry the normalized category, so the day's
		// own departures decide which glyphs the header shows — no separate
		// query, and the icons match the day being displayed.
		const categories = [
			...new Set(
				departures
					.map((d) => parseLineSlug(d.line).category)
					.filter((c): c is string => !!c),
			),
		];
		return {
			stopName: stop.stopName,
			categories,
			date,
			departures,
		};
	},
	{ freshMs: 60_000, staleMs: 15 * 60_000 },
);

const loadDay = createServerFn({ method: "GET" })
	.inputValidator((input: unknown): { slug: string; date: string } => {
		if (
			typeof input !== "object" ||
			input === null ||
			!("slug" in input) ||
			!("date" in input)
		) {
			throw new Error("invalid input");
		}
		const { slug, date } = input as { slug: unknown; date: unknown };
		if (typeof slug !== "string" || typeof date !== "string") {
			throw new Error("invalid input");
		}
		if (!DATE_RE.test(date)) throw new Error("invalid date");
		return { slug, date };
	})
	.handler(async ({ data: { slug, date } }): Promise<DayData> => {
		// Today is never cached — it changes with every ingest pass, and a
		// stale-while-revalidate copy would keep serving the old departures
		// to the reader whose request triggered the refresh. Past days are
		// settled and cache hard.
		if (date === todayBerlin()) {
			setResponseHeader("Cache-Control", "no-store");
		} else {
			setResponseHeader(
				"Cache-Control",
				"public, max-age=3600, s-maxage=86400, stale-while-revalidate=86400, immutable",
			);
		}
		const cached = await stationDaySwr.get(`${slug}|${date}`);
		if (!cached) throw new Error("not found");
		return cached;
	});

export const Route = createFileRoute("/$lang/$station/day/$date")({
	loader: async ({ params }) =>
		await loadDay({ data: { slug: params.station, date: params.date } }),
	// Per-day lists are one page per entity per day and go stale the
	// moment the day ends — they carry the crawler onward to the entity
	// pages without adding thousands of near-identical URLs to the index.
	head: ({ params, loaderData }) => {
		const l = langFromParams(params);
		const name = shortStationName(loaderData?.stopName ?? params.station);
		const date = prettyDate(l, params.date);
		return pageHead({
			lang: l,
			title: t(l, "seo.station.day", { name, date }),
			description: t(l, "seo.station.day_description", { name, date }),
			route: `${entityRoute("station", params.station)}/day/${params.date}`,
			noindex: true,
		});
	},
	validateSearch: (
		search: Record<string, unknown>,
	): { status?: string; hours?: string; dir?: string } => ({
		status: typeof search.status === "string" ? search.status : undefined,
		hours: typeof search.hours === "string" ? search.hours : undefined,
		dir: typeof search.dir === "string" ? search.dir : undefined,
	}),
	component: StationDay,
});

function StationDay() {
	const { stopName, date, departures } = Route.useLoaderData();
	const { lang, station } = Route.useParams();
	const search = Route.useSearch();
	const navigate = Route.useNavigate();
	const l = lang as Lang;
	const setSearch = (patch: Record<string, string | undefined>) =>
		navigate({
			search: (s) => ({ ...s, ...patch }),
			replace: true,
		});
	const [status, setStatus] = urlFilter(
		search.status,
		"all",
		STATUS_OPTS,
		setSearch,
		"status",
	);
	const [hours, setHours] = urlFilter(
		search.hours,
		"all",
		HOURS_OPTS,
		setSearch,
		"hours",
	);
	const [dir, setDir] = urlStringFilter(search.dir, "all", setSearch, "dir");
	const filters = useDepartureFilters(departures, {
		status: { value: status, onChange: setStatus },
		hours: { value: hours, onChange: setHours },
		dir: { value: dir, onChange: setDir },
	});

	const pretty = prettyDate(l, date);

	return (
		<main className="mx-auto max-w-3xl px-6 py-10 space-y-10">
			<PageHeader
				backLink={
					<Link to="/$lang/$station" params={{ lang: l, station }}>
						<BackLink>{shortStationName(stopName)}</BackLink>
					</Link>
				}
				title={shortStationName(stopName)}
			>
				<p>{pretty}</p>
			</PageHeader>

			<section className="space-y-4">
				<h2 className="eyebrow text-ink border-b border-ink pb-2">
					{t(l, "section.all_departures")}
				</h2>

				<div className="border-b border-rule pb-4">
					<DepartureFilterBar
						lang={l}
						{...filters}
						lines={[...new Set(filters.filtered.map((d) => d.line))].sort()}
					/>
				</div>

				{filters.filtered.length === 0 ? (
					<EmptyState title={t(l, "table.no_departures")} />
				) : (
					<>
						{/* Mobile: stacked cards. Horizontally-scrolling tables
						   on phones are awkward for the one-thumb scan the
						   information hierarchy actually needs — a per-row
						   card keeps each departure self-contained. */}
						<ul className="space-y-2 sm:hidden">
							{filters.filtered.map((d) => {
								const delay = delayMin(d.time, d.rtTime);
								const isRail = /^(ICE|IC|EC|RE|RB|S)\s?\d/i.test(d.line);
								const bahnUrl =
									isRail && delay !== null && delay >= 5
										? `https://bahn.expert/details/${encodeURIComponent(d.line)}/${d.date}T${d.time.replace(/:/g, "%3A")}.000Z`
										: null;
								return (
									<li
										key={`m-${d.journeyRef}-${d.routeIdx}`}
										className="border-b border-rule-dim py-3"
									>
										<div className="flex items-baseline justify-between gap-2">
											<span className="tabular-nums font-bold">
												{formatTime(d.time)}
												{d.rtTime && d.rtTime !== d.time && (
													<span className="ml-1 text-muted">
														→ {formatTime(d.rtTime)}
													</span>
												)}
											</span>
											<span className="figures text-meta text-muted">
												{parseLineSlug(d.line).line}
											</span>
										</div>
										<div
											className="mt-1 text-body truncate"
											title={d.direction}
										>
											{shortStationName(d.direction)}
										</div>
										<div className="mt-1 text-meta flex items-center gap-2">
											<StatusMark
												lang={l}
												cancelled={d.cancelled}
												ghost={d.ghost}
												delayMin={delay}
											/>
											{bahnUrl && (
												<a
													href={bahnUrl}
													target="_blank"
													rel="noopener noreferrer"
													className="text-accent"
												>
													why?
												</a>
											)}
										</div>
									</li>
								);
							})}
						</ul>

						{/* Desktop: compact 4-column table. */}
						<div className="hidden sm:block overflow-x-auto">
							<table className="report-table">
								<thead>
									<tr>
										<th>{t(l, "table.time")}</th>
										<th>{t(l, "table.line")}</th>
										<th>{t(l, "table.direction")}</th>
										<th>{t(l, "table.status")}</th>
									</tr>
								</thead>
								<tbody>
									{filters.filtered.map((d) => {
										const delay = delayMin(d.time, d.rtTime);
										const isRail = /^(ICE|IC|EC|RE|RB|S)\s?\d/i.test(d.line);
										const bahnUrl =
											isRail && delay !== null && delay >= 5
												? `https://bahn.expert/details/${encodeURIComponent(d.line)}/${d.date}T${d.time.replace(/:/g, "%3A")}.000Z`
												: null;
										return (
											<tr key={`${d.journeyRef}-${d.routeIdx}`}>
												<td className="figures whitespace-nowrap">
													{formatTime(d.time)}
													{d.rtTime && d.rtTime !== d.time && (
														<span className="ml-1 text-muted">
															→ {formatTime(d.rtTime)}
														</span>
													)}
												</td>
												<td className="figures text-meta text-muted">
													{parseLineSlug(d.line).line}
												</td>
												<td
													className="max-w-0 w-full truncate"
													title={d.direction}
												>
													{shortStationName(d.direction)}
												</td>
												<td>
													<div className="flex items-center gap-2">
														<StatusMark
															lang={l}
															cancelled={d.cancelled}
															ghost={d.ghost}
															delayMin={delay}
														/>
														{bahnUrl && (
															<a
																href={bahnUrl}
																target="_blank"
																rel="noopener noreferrer"
																className="text-accent text-meta"
															>
																why?
															</a>
														)}
													</div>
												</td>
											</tr>
										);
									})}
								</tbody>
							</table>
						</div>
					</>
				)}
			</section>
		</main>
	);
}

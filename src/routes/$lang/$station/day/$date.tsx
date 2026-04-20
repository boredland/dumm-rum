import { createFileRoute, Link } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { setResponseHeader } from "@tanstack/react-start/server";
import {
	DepartureFilterBar,
	useDepartureFilters,
} from "../../../../components/DepartureFilters.tsx";
import { EmptyState } from "../../../../components/EmptyState.tsx";
import {
	BackLink,
	SignageHeader,
} from "../../../../components/SignageHeader.tsx";
import { type Lang, t } from "../../../../lib/i18n.ts";
import {
	findStopBySlug,
	getStopDayDepartures,
	type StopDayDeparture,
} from "../../../../lib/queries.ts";
import { urlFilter, urlStringFilter } from "../../../../lib/search-state.ts";
import { categoryIcons } from "../../../../lib/stations.ts";
import { makeSwr } from "../../../../lib/swr.ts";
import {
	delayMin,
	formatTime,
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
		return {
			stopName: stop.stopName,
			categories: stop.categories,
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
		const isToday = date === todayBerlin();
		setResponseHeader(
			"Cache-Control",
			isToday
				? "public, max-age=30, s-maxage=60, stale-while-revalidate=900"
				: "public, max-age=3600, s-maxage=86400, stale-while-revalidate=86400, immutable",
		);
		const cached = await stationDaySwr.get(`${slug}|${date}`);
		if (!cached) throw new Error("not found");
		return cached;
	});

export const Route = createFileRoute("/$lang/$station/day/$date")({
	loader: async ({ params }) =>
		await loadDay({ data: { slug: params.station, date: params.date } }),
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
	const { stopName, categories, date, departures } = Route.useLoaderData();
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

	const pretty = new Date(`${date}T00:00:00`).toLocaleDateString(l, {
		weekday: "long",
		year: "numeric",
		month: "long",
		day: "numeric",
	});

	return (
		<main className="mx-auto max-w-4xl p-6 space-y-6">
			<SignageHeader
				backLink={
					<Link to="/$lang/$station" params={{ lang: l, station }}>
						<BackLink>{shortStationName(stopName)}</BackLink>
					</Link>
				}
				title={
					<>
						{categoryIcons(categories)} {shortStationName(stopName)}
					</>
				}
			>
				<p>{pretty}</p>
			</SignageHeader>

			<section>
				<h2 className="text-meta uppercase tracking-widest text-muted font-bold mb-3">
					{t(l, "section.all_departures")} ({filters.filtered.length}/
					{departures.length})
				</h2>

				<DepartureFilterBar
					lang={l}
					{...filters}
					lines={[...new Set(filters.filtered.map((d) => d.line))].sort()}
				/>

				{filters.filtered.length === 0 ? (
					<EmptyState icon="🕊️" title={t(l, "table.no_departures")} />
				) : (
					<>
						{/* Mobile: stacked cards. Horizontally-scrolling tables
						   on phones are awkward for the one-thumb scan the
						   information hierarchy actually needs — a per-row
						   card keeps each departure self-contained. */}
						<ul className="space-y-2 sm:hidden">
							{filters.filtered.map((d, i) => {
								const delay = delayMin(d.date, d.time, d.rtTime);
								const isRail = /^(ICE|IC|EC|RE|RB|S)\s?\d/i.test(d.line);
								const bahnUrl =
									isRail && delay !== null && delay >= 5
										? `https://bahn.expert/details/${encodeURIComponent(d.line)}/${d.date}T${d.time.replace(/:/g, "%3A")}.000Z`
										: null;
								return (
									<li
										key={`m-${i}-${d.time}-${d.line}-${d.direction}`}
										className="rounded-lg border border-border-dim p-3"
									>
										<div className="flex items-baseline justify-between gap-2">
											<span className="tabular-nums font-bold">
												{formatTime(d.time)}
												{d.rtTime && d.rtTime !== d.time && (
													<span className="ml-1 text-dimmed font-normal">
														→ {formatTime(d.rtTime)}
													</span>
												)}
											</span>
											<span className="text-body font-bold">{d.line}</span>
										</div>
										<div
											className="mt-1 text-body truncate"
											title={d.direction}
										>
											{d.direction}
										</div>
										<div className="mt-1 text-meta">
											{d.cancelled ? (
												<span className="text-danger">❌</span>
											) : d.ghost ? (
												<span className="text-info">👻</span>
											) : delay !== null && delay >= 8 ? (
												<span className="text-warn">
													⏳ +{delay} min
													{bahnUrl && (
														<a
															href={bahnUrl}
															target="_blank"
															rel="noopener noreferrer"
															className="ml-1 text-accent"
														>
															why?
														</a>
													)}
												</span>
											) : (
												<span className="text-ok">✅</span>
											)}
										</div>
									</li>
								);
							})}
						</ul>

						{/* Desktop: compact 4-column table. */}
						<div className="hidden sm:block overflow-x-auto">
							<table className="w-full text-body">
								<thead>
									<tr className="text-left text-meta uppercase text-muted border-b border-border-dim">
										<th className="py-2 pr-3">{t(l, "table.time")}</th>
										<th className="py-2 pr-3">{t(l, "table.line")}</th>
										<th className="py-2 pr-3">{t(l, "table.direction")}</th>
										<th className="py-2 pr-3">{t(l, "table.status")}</th>
									</tr>
								</thead>
								<tbody>
									{filters.filtered.map((d, i) => {
										const delay = delayMin(d.date, d.time, d.rtTime);
										const isRail = /^(ICE|IC|EC|RE|RB|S)\s?\d/i.test(d.line);
										const bahnUrl =
											isRail && delay !== null && delay >= 5
												? `https://bahn.expert/details/${encodeURIComponent(d.line)}/${d.date}T${d.time.replace(/:/g, "%3A")}.000Z`
												: null;
										return (
											<tr
												key={`${i}-${d.time}-${d.line}-${d.direction}`}
												className="border-b border-border-dim"
											>
												<td className="py-2 pr-3 whitespace-nowrap tabular-nums">
													{formatTime(d.time)}
													{d.rtTime && d.rtTime !== d.time && (
														<span className="ml-1 text-dimmed">
															→ {formatTime(d.rtTime)}
														</span>
													)}
												</td>
												<td className="py-2 pr-3 font-bold">{d.line}</td>
												<td className="py-2 pr-3 truncate" title={d.direction}>
													{d.direction}
												</td>
												<td className="py-2 pr-3">
													{d.cancelled ? (
														<span className="text-danger">❌</span>
													) : d.ghost ? (
														<span className="text-info">👻</span>
													) : delay !== null && delay >= 8 ? (
														<span className="text-warn">
															⏳ +{delay} min
															{bahnUrl && (
																<a
																	href={bahnUrl}
																	target="_blank"
																	rel="noopener noreferrer"
																	className="ml-1 text-accent text-meta"
																>
																	why?
																</a>
															)}
														</span>
													) : (
														<span className="text-ok">✅</span>
													)}
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

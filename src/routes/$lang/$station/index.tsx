import { createFileRoute, Link } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { setResponseHeader } from "@tanstack/react-start/server";
import { useState } from "react";
import {
	DaysToggleBar,
	useDaysFilter,
} from "../../../components/DaysToggle.tsx";
import { DepartureRow } from "../../../components/DepartureRow.tsx";
import { EmptyState } from "../../../components/EmptyState.tsx";
import { Figure, Figures } from "../../../components/Figures.tsx";
import {
	AlertButton,
	BackLink,
	PageHeader,
} from "../../../components/PageHeader.tsx";
import { SubscribeModal } from "../../../components/SubscribeModal.tsx";
import { type Lang, langFromParams, t } from "../../../lib/i18n.ts";
import {
	type DayStats,
	findStopBySlug,
	getStopDayDepartures,
	getStopStats,
	type StopDayDeparture,
} from "../../../lib/queries.ts";
import { urlFilter } from "../../../lib/search-state.ts";
import {
	breadcrumbJsonLd,
	entityDescription,
	entityJsonLd,
	entityRoute,
	pageHead,
} from "../../../lib/seo.ts";
import {
	toneForCancRate,
	toneForCount,
	toneForScore,
} from "../../../lib/status.ts";
import { makeSwr } from "../../../lib/swr.ts";
import {
	onTimeRate,
	parseLineSlug,
	pct,
	shortStationName,
	todayBerlin,
} from "../../../lib/utils.ts";

interface StationData {
	stopName: string;
	categories: string[];
	stopIds: string[];
	days: DayStats[];
	lastChange: string | null;
	nextDepartures: StopDayDeparture[];
}

/** Full day of departures cached once; the route handler filters down to
 * "next 20 from now" per request so the clock stays live even when the
 * SWR memo doesn't refresh. */
interface StationCacheValue {
	stopName: string;
	categories: string[];
	stopIds: string[];
	days: DayStats[];
	lastChange: string | null;
	departures: StopDayDeparture[];
}

const stationSwr = makeSwr<StationCacheValue | null>(
	async (slug) => {
		const stop = await findStopBySlug(slug);
		if (!stop) return null;
		const today = todayBerlin();
		const [stats, departures] = await Promise.all([
			getStopStats(stop.stopIds),
			getStopDayDepartures(stop.stopIds, today),
		]);
		return {
			stopName: stop.stopName,
			categories: stats.categories,
			stopIds: stop.stopIds,
			days: stats.days,
			lastChange: stats.lastChange,
			departures,
		};
	},
	{ freshMs: 60_000, staleMs: 15 * 60_000 },
);

const loadStation = createServerFn({ method: "GET" })
	.inputValidator((slug: unknown): string => {
		if (typeof slug !== "string") throw new Error("invalid slug");
		return slug;
	})
	.handler(async ({ data: slug }): Promise<StationData> => {
		setResponseHeader(
			"Cache-Control",
			"public, max-age=30, s-maxage=60, stale-while-revalidate=900",
		);
		const cached = await stationSwr.get(slug);
		if (!cached) throw new Error("not found");
		const nowTime = new Date().toLocaleTimeString("de", {
			hour: "2-digit",
			minute: "2-digit",
			second: "2-digit",
			hour12: false,
			timeZone: "Europe/Berlin",
		});
		const nextDepartures = cached.departures
			.filter((d) => d.time >= nowTime)
			.slice(0, 20);
		return {
			stopName: cached.stopName,
			categories: cached.categories,
			stopIds: cached.stopIds,
			days: cached.days,
			lastChange: cached.lastChange,
			nextDepartures,
		};
	});

const DAYS_FILTER_OPTS = ["all", "today", "weekdays", "weekends"] as const;

export const Route = createFileRoute("/$lang/$station/")({
	staleTime: 5 * 60 * 1000,
	loader: async ({ params }) => await loadStation({ data: params.station }),
	validateSearch: (search: Record<string, unknown>): { days?: string } => ({
		days: typeof search.days === "string" ? search.days : undefined,
	}),
	head: ({ params, loaderData }) => {
		const l = langFromParams(params);
		const name = shortStationName(loaderData?.stopName ?? params.station);
		const route = entityRoute("station", params.station);
		const description = entityDescription(
			l,
			"station",
			name,
			loaderData?.days ?? [],
		);
		return pageHead({
			lang: l,
			title: name,
			description,
			route,
			jsonLd: [
				entityJsonLd({ lang: l, name, description, route }),
				breadcrumbJsonLd(l, [
					{ name: t(l, "home.title"), route: "" },
					{ name, route },
				]),
			],
		});
	},
	component: StationIndex,
});

function StationIndex() {
	const { stopName, categories, days, lastChange, nextDepartures } =
		Route.useLoaderData();
	const { lang, station } = Route.useParams();
	const l = lang as Lang;
	const search = Route.useSearch();
	const navigate = Route.useNavigate();
	const [daysValue, setDaysValue] = urlFilter(
		search.days,
		"all",
		DAYS_FILTER_OPTS,
		(patch) =>
			navigate({
				search: (s) => ({ ...s, ...patch }),
				replace: true,
			}),
		"days",
	);
	const daysFilter = useDaysFilter(days, {
		value: daysValue,
		onChange: setDaysValue,
	});
	const [subscribeOpen, setSubscribeOpen] = useState(false);

	const today = days[0];
	const total7 = days.slice(0, 7).reduce((a, d) => a + d.total, 0);
	const canc7 = days.slice(0, 7).reduce((a, d) => a + d.cancelled, 0);
	const ghost7 = days.slice(0, 7).reduce((a, d) => a + d.ghost, 0);
	const delayed7 = days.slice(0, 7).reduce((a, d) => a + d.delayed, 0);
	const score7 = onTimeRate(canc7, delayed7, total7);

	return (
		<main className="mx-auto max-w-3xl px-6 py-10 space-y-10">
			<PageHeader
				backLink={
					<Link to="/$lang" params={{ lang: l }}>
						<BackLink>{t(l, "nav.back")}</BackLink>
					</Link>
				}
				title={shortStationName(stopName)}
				action={
					<AlertButton
						label={t(l, "subscribe.cta.button")}
						onClick={() => setSubscribeOpen(true)}
					/>
				}
			>
				{categories.length > 0 && <p>{categories.join(" · ")}</p>}
				{lastChange && (
					<p>
						{t(l, "station.last_updated")}:{" "}
						{new Date(lastChange).toLocaleString(l)}
					</p>
				)}
			</PageHeader>

			{subscribeOpen && (
				<SubscribeModal
					lang={l}
					initial={{ stopName }}
					onClose={() => setSubscribeOpen(false)}
				/>
			)}

			{today && (
				<Figures>
					<Figure label={t(l, "stat.today")} value={String(today.total)} />
					<Figure
						label={t(l, "stat.cancelled")}
						value={`${pct(today.cancelled, today.total)}%`}
						tone={toneForCancRate(today.cancelled / (today.total || 1))}
					/>
					<Figure
						label={t(l, "stat.ghost")}
						value={`${pct(today.ghost, today.total)}%`}
						tone={today.ghost > 0 ? "text-ghost" : "text-muted"}
					/>
					<Figure
						label={t(l, "stat.reliability")}
						value={`${onTimeRate(today.cancelled, today.delayed, today.total)}%`}
						tone={toneForScore(
							onTimeRate(today.cancelled, today.delayed, today.total),
						)}
					/>
				</Figures>
			)}

			{nextDepartures.length > 0 && (
				<section className="space-y-3">
					<h2 className="eyebrow text-ink border-b border-ink pb-2">
						{t(l, "section.next_departures")}
					</h2>
					<ul>
						{nextDepartures.map((d) => {
							const delay =
								d.rtTime && d.time
									? Math.round(
											(new Date(`${d.date}T${d.rtTime}`).getTime() -
												new Date(`${d.date}T${d.time}`).getTime()) /
												60_000,
										)
									: null;
							return (
								<DepartureRow
									key={`${d.time}-${d.line}-${d.direction}`}
									lang={l}
									time={d.time}
									rtTime={d.rtTime}
									line={parseLineSlug(d.line).line}
									direction={d.direction}
									cancelled={d.cancelled}
									ghost={d.ghost}
									delayMin={delay}
								/>
							);
						})}
					</ul>
				</section>
			)}

			<section className="space-y-3">
				<h2 className="eyebrow text-ink border-b border-ink pb-2">
					{t(l, "section.daily_breakdown")}
				</h2>
				<DaysToggleBar
					lang={l}
					active={daysFilter.active}
					setActive={daysFilter.setActive}
				/>
				{daysFilter.filtered.length === 0 ? (
					<EmptyState title={t(l, "table.no_data")} />
				) : (
					<div className="overflow-x-auto">
						<table className="report-table">
							<thead>
								<tr>
									<th>{t(l, "table.date")}</th>
									<th className="num">{t(l, "table.th.total")}</th>
									<th className="num">{t(l, "table.th.cancelled")}</th>
									<th className="num">{t(l, "table.th.ghost")}</th>
									<th className="num">{t(l, "table.th.delayed")}</th>
									<th className="num">{t(l, "table.otp")}</th>
									<th />
								</tr>
							</thead>
							<tbody>
								{daysFilter.filtered.map((d) => {
									const dayScore = onTimeRate(d.cancelled, d.delayed, d.total);
									return (
										<tr key={d.date}>
											<td className="whitespace-nowrap">
												{new Date(`${d.date}T00:00:00`).toLocaleDateString(l, {
													weekday: "short",
													day: "2-digit",
													month: "2-digit",
												})}
											</td>
											<td className="num text-muted">{d.total}</td>
											<td className={`num ${toneForCount(d.cancelled, "bad")}`}>
												{d.cancelled || "—"}
											</td>
											<td className={`num ${toneForCount(d.ghost, "ghost")}`}>
												{d.ghost || "—"}
											</td>
											<td className={`num ${toneForCount(d.delayed, "mixed")}`}>
												{d.delayed || "—"}
											</td>
											<td className={`num ${toneForScore(dayScore)}`}>
												{dayScore}%
											</td>
											<td className="num">
												<Link
													to="/$lang/$station/day/$date"
													params={{ lang: l, station, date: d.date }}
													className="text-meta text-muted hover:text-ink"
												>
													→
												</Link>
											</td>
										</tr>
									);
								})}
							</tbody>
						</table>
					</div>
				)}
			</section>

			{days.length > 0 && (
				<p className="text-meta text-muted border-t border-rule pt-4">
					{t(l, "station.seven_day", {
						total: total7,
						cancelled: canc7,
						ghost: ghost7,
						delayed: delayed7,
						score: score7,
					})}
				</p>
			)}
		</main>
	);
}

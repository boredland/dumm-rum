import { createFileRoute, Link } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { setResponseHeader } from "@tanstack/react-start/server";
import { useState } from "react";
import {
	DaysToggleBar,
	useDaysFilter,
} from "../../../components/DaysToggle.tsx";
import { EmptyState } from "../../../components/EmptyState.tsx";
import { LedRow } from "../../../components/LedRow.tsx";
import {
	BackLink,
	SignageHeader,
	SubscribeButton,
} from "../../../components/SignageHeader.tsx";
import { borderForCancRate, StatCard } from "../../../components/StatCard.tsx";
import { SubscribeModal } from "../../../components/SubscribeModal.tsx";
import { type Lang, t } from "../../../lib/i18n.ts";
import {
	type DayStats,
	findStopBySlug,
	getStopDayDepartures,
	getStopStats,
	type StopDayDeparture,
} from "../../../lib/queries.ts";
import { urlFilter } from "../../../lib/search-state.ts";
import { categoryIcons } from "../../../lib/stations.ts";
import { ledForCount, ledForScore } from "../../../lib/status.ts";
import { makeSwr } from "../../../lib/swr.ts";
import {
	onTimeRate,
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
			categories: stop.categories,
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
	head: ({ loaderData }) => {
		const name = loaderData?.stopName ?? "Station";
		return {
			meta: [
				{ title: `${name} — DummRum` },
				{ property: "og:title", content: `${name} — DummRum` },
			],
		};
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
		<main className="mx-auto max-w-4xl p-6 space-y-6">
			<SignageHeader
				backLink={
					<Link to="/$lang" params={{ lang: l }}>
						<BackLink>{t(l, "nav.back")}</BackLink>
					</Link>
				}
				title={
					<>
						{categoryIcons(categories)} {shortStationName(stopName)}
					</>
				}
				action={
					<SubscribeButton
						label={t(l, "subscribe.cta.button")}
						onClick={() => setSubscribeOpen(true)}
					/>
				}
			>
				{lastChange && (
					<p>
						{t(l, "station.last_updated")}:{" "}
						{new Date(lastChange).toLocaleString(l)}
					</p>
				)}
			</SignageHeader>

			{subscribeOpen && (
				<SubscribeModal
					lang={l}
					initial={{ stopName }}
					onClose={() => setSubscribeOpen(false)}
				/>
			)}

			{today && (
				<section className="grid grid-cols-2 sm:grid-cols-4 gap-3">
					<StatCard label={t(l, "stat.today")} value={String(today.total)} />
					<StatCard
						label={t(l, "stat.cancelled")}
						value={`${pct(today.cancelled, today.total)}%`}
						tone={
							today.cancelled / (today.total || 1) > 0.05 ? "danger" : undefined
						}
					/>
					<StatCard
						label={t(l, "stat.ghost")}
						value={`${pct(today.ghost, today.total)}%`}
						tone={today.ghost > 0 ? "info" : undefined}
					/>
					<StatCard
						label={t(l, "stat.reliability")}
						value={`${onTimeRate(today.cancelled, today.delayed, today.total)}%`}
					/>
				</section>
			)}

			{nextDepartures.length > 0 && (
				<section>
					<h2 className="signage-label mb-3 block">
						{t(l, "section.next_departures")} ({nextDepartures.length})
					</h2>
					<ul className="space-y-1">
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
								<LedRow
									key={`${d.time}-${d.line}-${d.direction}`}
									time={d.time}
									rtTime={d.rtTime}
									line={d.line}
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

			<section>
				<h2 className="signage-label mb-3 block">
					{t(l, "section.daily_breakdown")} ({daysFilter.filtered.length})
				</h2>
				<DaysToggleBar
					lang={l}
					active={daysFilter.active}
					setActive={daysFilter.setActive}
				/>
				{daysFilter.filtered.length === 0 ? (
					<EmptyState icon="⌛" title={t(l, "table.no_data")} />
				) : (
					<div className="overflow-x-auto">
						<table className="w-full text-sm">
							<thead>
								<tr className="text-left signage-label border-b border-border">
									<th className="py-2 pr-4">{t(l, "table.date")}</th>
									<th className="py-2 pr-4 text-right">
										{t(l, "table.th.total")}
									</th>
									<th className="py-2 pr-4 text-right">
										{t(l, "table.th.cancelled")}
									</th>
									<th className="py-2 pr-4 text-right">
										{t(l, "table.th.ghost")}
									</th>
									<th className="py-2 pr-4 text-right">
										{t(l, "table.th.delayed")}
									</th>
									<th className="py-2 pr-4 text-right">{t(l, "table.otp")}</th>
									<th className="py-2 pr-4" />
								</tr>
							</thead>
							<tbody>
								{daysFilter.filtered.map((d) => {
									const rate = d.total > 0 ? d.cancelled / d.total : 0;
									const border = borderForCancRate(rate);
									const score = onTimeRate(d.cancelled, d.delayed, d.total);
									return (
										<tr
											key={d.date}
											className={`border-l-2 ${border} border-b border-border-dim`}
										>
											<td className="py-2 pr-4 pl-2 whitespace-nowrap">
												{new Date(`${d.date}T00:00:00`).toLocaleDateString(l, {
													weekday: "short",
													day: "2-digit",
													month: "2-digit",
												})}
											</td>
											<td className="py-2 pr-4 text-right tabular-nums">
												{d.total}
											</td>
											<td
												className={`py-2 pr-4 text-right tabular-nums ${ledForCount(d.cancelled, "danger")}`}
											>
												{d.cancelled || "—"}
											</td>
											<td
												className={`py-2 pr-4 text-right tabular-nums ${ledForCount(d.ghost, "info")}`}
											>
												{d.ghost || "—"}
											</td>
											<td
												className={`py-2 pr-4 text-right tabular-nums ${ledForCount(d.delayed, "warn")}`}
											>
												{d.delayed || "—"}
											</td>
											<td
												className={`py-2 pr-4 text-right tabular-nums font-bold ${ledForScore(score)}`}
											>
												{score}%
											</td>
											<td className="py-2 pr-4 text-right">
												<Link
													to="/$lang/$station/day/$date"
													params={{ lang: l, station, date: d.date }}
													className="text-xs"
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
				<section className="text-xs text-muted">
					7-day: {total7} departures · {canc7} cancelled · {ghost7} ghost ·{" "}
					{delayed7} delayed · {score7}% OTP
				</section>
			)}
		</main>
	);
}

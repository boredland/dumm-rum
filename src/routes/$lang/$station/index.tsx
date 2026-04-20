import { createFileRoute, Link } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { setResponseHeader } from "@tanstack/react-start/server";
import { useState } from "react";
import {
	DaysToggleBar,
	useDaysFilter,
} from "../../../components/DaysToggle.tsx";
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
			<header className="space-y-1">
				<Link
					to="/$lang"
					params={{ lang: l }}
					className="text-sm text-muted hover:text-fg"
				>
					← {t(l, "nav.back")}
				</Link>
				<div className="flex items-center justify-between gap-3 mt-2 flex-wrap">
					<h1 className="text-h1 font-black flex items-center gap-2">
						{categoryIcons(categories)} {shortStationName(stopName)}
					</h1>
					<button
						type="button"
						onClick={() => setSubscribeOpen(true)}
						className="px-3 py-1.5 text-xs font-bold rounded-full border border-border text-accent hover:bg-surface-hover cursor-pointer transition-colors"
					>
						{t(l, "subscribe.cta.button")}
					</button>
				</div>
				{lastChange && (
					<p className="text-xs text-dimmed">
						{t(l, "station.last_updated")}:{" "}
						{new Date(lastChange).toLocaleString(l)}
					</p>
				)}
			</header>

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
					<h2 className="text-meta uppercase tracking-widest text-muted font-bold mb-3">
						{t(l, "section.next_departures")} ({nextDepartures.length})
					</h2>
					<div className="overflow-x-auto">
						<table className="w-full text-sm">
							<thead>
								<tr className="text-left text-xs uppercase text-muted border-b border-border-dim">
									<th className="py-2 pr-3">{t(l, "table.time")}</th>
									<th className="py-2 pr-3">{t(l, "table.line")}</th>
									<th className="py-2 pr-3">{t(l, "table.direction")}</th>
									<th className="py-2 pr-3">{t(l, "table.status")}</th>
								</tr>
							</thead>
							<tbody>
								{nextDepartures.map((d, i) => {
									const delay =
										d.rtTime && d.time
											? Math.round(
													(new Date(`${d.date}T${d.rtTime}`).getTime() -
														new Date(`${d.date}T${d.time}`).getTime()) /
														60_000,
												)
											: null;
									return (
										<tr
											key={`${i}-${d.time}-${d.line}`}
											className="border-b border-border-dim"
										>
											<td className="py-2 pr-3 whitespace-nowrap tabular-nums">
												{d.time.slice(0, 5)}
												{d.rtTime && d.rtTime !== d.time && (
													<span className="ml-1 text-dimmed">
														→ {d.rtTime.slice(0, 5)}
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
													<span className="text-warn">⏳ +{delay} min</span>
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
				</section>
			)}

			<section>
				<h2 className="text-meta uppercase tracking-widest text-muted font-bold mb-3">
					{t(l, "section.daily_breakdown")} ({daysFilter.filtered.length})
				</h2>
				<DaysToggleBar
					lang={l}
					active={daysFilter.active}
					setActive={daysFilter.setActive}
				/>
				{daysFilter.filtered.length === 0 ? (
					<p className="text-sm text-dimmed">{t(l, "table.no_data")}</p>
				) : (
					<div className="overflow-x-auto">
						<table className="w-full text-sm">
							<thead>
								<tr className="text-left text-xs uppercase text-muted border-b border-border-dim">
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
											<td className="py-2 pr-4 text-right tabular-nums">
												{d.cancelled}
											</td>
											<td className="py-2 pr-4 text-right tabular-nums text-info">
												{d.ghost || "—"}
											</td>
											<td className="py-2 pr-4 text-right tabular-nums">
												{d.delayed}
											</td>
											<td className="py-2 pr-4 text-right tabular-nums font-bold">
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

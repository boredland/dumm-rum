import { createFileRoute, Link } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import {
	DaysToggleBar,
	useDaysFilter,
} from "../../../components/DaysToggle.tsx";
import { borderForCancRate, StatCard } from "../../../components/StatCard.tsx";
import { type Lang, t } from "../../../lib/i18n.ts";
import {
	type DayStats,
	findStopBySlug,
	getStopDayDepartures,
	getStopStats,
	type StopDayDeparture,
} from "../../../lib/queries.ts";
import { categoryIcons } from "../../../lib/stations.ts";
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

const loadStation = createServerFn({ method: "GET" })
	.inputValidator((slug: unknown): string => {
		if (typeof slug !== "string") throw new Error("invalid slug");
		return slug;
	})
	.handler(async ({ data: slug }): Promise<StationData> => {
		const stop = await findStopBySlug(slug);
		if (!stop) throw new Error("not found");
		const today = todayBerlin();
		const [stats, departures] = await Promise.all([
			getStopStats(stop.stopIds),
			getStopDayDepartures(stop.stopIds, today),
		]);
		const nowTime = new Date().toLocaleTimeString("de", {
			hour: "2-digit",
			minute: "2-digit",
			second: "2-digit",
			hour12: false,
			timeZone: "Europe/Berlin",
		});
		const nextDepartures = departures
			.filter((d) => d.time >= nowTime)
			.slice(0, 20);
		return {
			stopName: stop.stopName,
			categories: stop.categories,
			stopIds: stop.stopIds,
			days: stats.days,
			lastChange: stats.lastChange,
			nextDepartures,
		};
	});

export const Route = createFileRoute("/$lang/$station/")({
	staleTime: 5 * 60 * 1000,
	loader: async ({ params }) => await loadStation({ data: params.station }),
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
	const daysFilter = useDaysFilter(days);

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
				<h1 className="text-3xl font-bold flex items-center gap-2 mt-2">
					{categoryIcons(categories)} {shortStationName(stopName)}
				</h1>
				{lastChange && (
					<p className="text-xs text-dimmed">
						{t(l, "station.last_updated")}:{" "}
						{new Date(lastChange).toLocaleString(l)}
					</p>
				)}
			</header>

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
						tone={today.ghost > 0 ? "purple" : undefined}
					/>
					<StatCard
						label={t(l, "stat.reliability")}
						value={`${onTimeRate(today.cancelled, today.delayed, today.total)}%`}
					/>
				</section>
			)}

			{nextDepartures.length > 0 && (
				<section>
					<h2 className="text-xs uppercase tracking-wide text-muted font-semibold mb-3">
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
											<td className="py-2 pr-3 font-semibold">{d.line}</td>
											<td className="py-2 pr-3 truncate" title={d.direction}>
												{d.direction}
											</td>
											<td className="py-2 pr-3">
												{d.cancelled ? (
													<span className="text-red-500">❌</span>
												) : d.ghost ? (
													<span className="text-purple-400">👻</span>
												) : delay !== null && delay >= 8 ? (
													<span className="text-amber-500">
														⏳ +{delay} min
													</span>
												) : (
													<span className="text-emerald-500">✅</span>
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
				<h2 className="text-xs uppercase tracking-wide text-muted font-semibold mb-3">
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
											<td className="py-2 pr-4 text-right tabular-nums text-purple-400">
												{d.ghost || "—"}
											</td>
											<td className="py-2 pr-4 text-right tabular-nums">
												{d.delayed}
											</td>
											<td className="py-2 pr-4 text-right tabular-nums font-semibold">
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

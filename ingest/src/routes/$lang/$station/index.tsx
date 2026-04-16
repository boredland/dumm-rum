import { createFileRoute, Link } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { type Lang, t } from "../../../lib/i18n.ts";
import {
	type DayStats,
	findStopBySlug,
	getStopStats,
} from "../../../lib/queries.ts";
import { categoryIcons } from "../../../lib/stations.ts";
import { onTimeRate, pct, shortStationName } from "../../../lib/utils.ts";

interface StationData {
	stopName: string;
	categories: string[];
	stopIds: string[];
	days: DayStats[];
	lastChange: string | null;
}

const loadStation = createServerFn({ method: "GET" })
	.inputValidator((slug: unknown): string => {
		if (typeof slug !== "string") throw new Error("invalid slug");
		return slug;
	})
	.handler(async ({ data: slug }): Promise<StationData> => {
		const stop = await findStopBySlug(slug);
		if (!stop) throw new Error("not found");
		const stats = await getStopStats(stop.stopIds);
		return {
			stopName: stop.stopName,
			categories: stop.categories,
			stopIds: stop.stopIds,
			days: stats.days,
			lastChange: stats.lastChange,
		};
	});

export const Route = createFileRoute("/$lang/$station/")({
	loader: async ({ params }) => await loadStation({ data: params.station }),
	head: ({ loaderData }) => ({
		meta: [{ title: `${loaderData?.stopName ?? "Station"} — DummRum` }],
	}),
	component: StationIndex,
});

function borderForCancRate(rate: number): string {
	if (rate > 0.1) return "border-red-500";
	if (rate > 0.05) return "border-amber-500";
	return "border-emerald-500";
}

function StationIndex() {
	const { stopName, categories, days, lastChange } = Route.useLoaderData();
	const { lang, station } = Route.useParams();
	const l = lang as Lang;

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

			<section>
				<h2 className="text-xs uppercase tracking-wide text-muted font-semibold mb-3">
					{t(l, "section.daily_breakdown")} ({days.length})
				</h2>
				{days.length === 0 ? (
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
								{days.map((d) => {
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

function StatCard({
	label,
	value,
	tone,
}: {
	label: string;
	value: string;
	tone?: "danger" | "purple";
}) {
	const color =
		tone === "danger"
			? "text-red-500"
			: tone === "purple"
				? "text-purple-400"
				: "";
	return (
		<div className="bg-surface border border-border rounded-xl p-4">
			<div className="text-[0.7rem] uppercase tracking-wide text-muted mb-1">
				{label}
			</div>
			<div className={`text-2xl font-bold tabular-nums ${color}`}>{value}</div>
		</div>
	);
}

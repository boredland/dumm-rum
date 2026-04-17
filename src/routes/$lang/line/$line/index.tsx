import { createFileRoute, Link } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { useState } from "react";
import {
	DaysToggleBar,
	useDaysFilter,
} from "../../../../components/DaysToggle.tsx";
import {
	borderForCancRate,
	StatCard,
} from "../../../../components/StatCard.tsx";
import { SubscribeModal } from "../../../../components/SubscribeModal.tsx";
import { type Lang, t } from "../../../../lib/i18n.ts";
import { getLineStats, type LineStats } from "../../../../lib/queries.ts";
import { categoryIcons } from "../../../../lib/stations.ts";
import { onTimeRate } from "../../../../lib/utils.ts";

const loadLine = createServerFn({ method: "GET" })
	.inputValidator((line: unknown): string => {
		if (typeof line !== "string" || line.length === 0) {
			throw new Error("invalid line");
		}
		return line;
	})
	.handler(
		async ({ data: line }): Promise<{ line: string; stats: LineStats }> => {
			const stats = await getLineStats(line);
			return { line, stats };
		},
	);

export const Route = createFileRoute("/$lang/line/$line/")({
	staleTime: 5 * 60 * 1000,
	loader: async ({ params }) => await loadLine({ data: params.line }),
	head: ({ loaderData }) => {
		const name = loaderData?.line ?? "Line";
		return {
			meta: [
				{ title: `${name} — DummRum` },
				{ property: "og:title", content: `${name} — DummRum` },
			],
		};
	},
	component: LineIndex,
});

function LineIndex() {
	const { line, stats } = Route.useLoaderData();
	const { lang } = Route.useParams();
	const l = lang as Lang;
	const daysFilter = useDaysFilter(stats.days);
	const [subscribeOpen, setSubscribeOpen] = useState(false);

	const total = stats.days.reduce((a, d) => a + d.total, 0);
	const canc = stats.days.reduce((a, d) => a + d.cancelled, 0);
	const ghost = stats.days.reduce((a, d) => a + d.ghost, 0);
	const delayed = stats.days.reduce((a, d) => a + d.delayed, 0);
	const score = onTimeRate(canc, delayed, total);

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
					<h1 className="text-3xl font-bold flex items-center gap-2">
						{categoryIcons(stats.categories)} {line}
					</h1>
					<button
						type="button"
						onClick={() => setSubscribeOpen(true)}
						className="px-3 py-1.5 text-xs font-medium rounded-full border border-border text-accent hover:bg-surface-hover cursor-pointer transition-colors"
					>
						{t(l, "subscribe.cta.button")}
					</button>
				</div>
				{stats.destinations.length > 0 && (
					<p className="text-sm text-muted">{stats.destinations.join(" ↔ ")}</p>
				)}
				{stats.operators.length > 0 && (
					<p className="text-xs text-dimmed">{stats.operators.join(", ")}</p>
				)}
			</header>

			{subscribeOpen && (
				<SubscribeModal
					lang={l}
					initial={{ line }}
					availableDirections={stats.destinations}
					onClose={() => setSubscribeOpen(false)}
				/>
			)}

			<section className="grid grid-cols-2 sm:grid-cols-4 gap-3">
				<StatCard label={t(l, "stat.departures")} value={String(total)} />
				<StatCard
					label={t(l, "home.cancelled")}
					value={`${((canc / (total || 1)) * 100).toFixed(1)}%`}
					tone={canc / (total || 1) > 0.05 ? "danger" : undefined}
				/>
				<StatCard
					label={t(l, "home.ghost")}
					value={`${((ghost / (total || 1)) * 100).toFixed(1)}%`}
					tone={ghost > 0 ? "purple" : undefined}
				/>
				<StatCard label={t(l, "stat.reliability")} value={`${score}%`} />
			</section>

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
									const dayScore = onTimeRate(d.cancelled, d.delayed, d.total);
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
												{dayScore}%
											</td>
											<td className="py-2 pr-4 text-right">
												<Link
													to="/$lang/line/$line/day/$date"
													params={{ lang: l, line, date: d.date }}
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
		</main>
	);
}

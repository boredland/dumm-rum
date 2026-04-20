import { createFileRoute, Link } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { setResponseHeader } from "@tanstack/react-start/server";
import {
	DaysToggleBar,
	useDaysFilter,
} from "../../../../components/DaysToggle.tsx";
import { EmptyState } from "../../../../components/EmptyState.tsx";
import {
	BackLink,
	SignageHeader,
} from "../../../../components/SignageHeader.tsx";
import {
	borderForCancRate,
	StatCard,
} from "../../../../components/StatCard.tsx";
import { ledForCount, ledForScore } from "../../../../lib/status.ts";
import { type Lang, t } from "../../../../lib/i18n.ts";
import {
	getOperatorStats,
	type OperatorStats,
} from "../../../../lib/queries.ts";
import { urlFilter } from "../../../../lib/search-state.ts";
import { categoryIcons } from "../../../../lib/stations.ts";
import { makeSwr } from "../../../../lib/swr.ts";
import { onTimeRate } from "../../../../lib/utils.ts";

const DAYS_FILTER_OPTS = ["all", "today", "weekdays", "weekends"] as const;

const operatorSwr = makeSwr<{ operator: string; stats: OperatorStats }>(
	async (operator) => ({ operator, stats: await getOperatorStats(operator) }),
	{ freshMs: 60_000, staleMs: 15 * 60_000 },
);

const loadOperator = createServerFn({ method: "GET" })
	.inputValidator((op: unknown): string => {
		if (typeof op !== "string" || op.length === 0) throw new Error("invalid");
		return op;
	})
	.handler(async ({ data: operator }) => {
		setResponseHeader(
			"Cache-Control",
			"public, max-age=30, s-maxage=60, stale-while-revalidate=900",
		);
		return operatorSwr.get(operator);
	});

export const Route = createFileRoute("/$lang/operator/$operator/")({
	staleTime: 5 * 60 * 1000,
	loader: async ({ params }) => await loadOperator({ data: params.operator }),
	validateSearch: (search: Record<string, unknown>): { days?: string } => ({
		days: typeof search.days === "string" ? search.days : undefined,
	}),
	head: ({ loaderData }) => {
		const name = loaderData?.operator ?? "Operator";
		return {
			meta: [
				{ title: `${name} — DummRum` },
				{ property: "og:title", content: `${name} — DummRum` },
			],
		};
	},
	component: OperatorIndex,
});

function OperatorIndex() {
	const { operator, stats } = Route.useLoaderData();
	const { lang } = Route.useParams();
	const search = Route.useSearch();
	const navigate = Route.useNavigate();
	const l = lang as Lang;
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
	const daysFilter = useDaysFilter(stats.days, {
		value: daysValue,
		onChange: setDaysValue,
	});

	const total = stats.days.reduce((a, d) => a + d.total, 0);
	const canc = stats.days.reduce((a, d) => a + d.cancelled, 0);
	const ghost = stats.days.reduce((a, d) => a + d.ghost, 0);
	const delayed = stats.days.reduce((a, d) => a + d.delayed, 0);
	const score = onTimeRate(canc, delayed, total);

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
						{categoryIcons(stats.categories)} {operator}
					</>
				}
			>
				{stats.lines.length > 0 && (
					<p>
						{t(l, "operator.lines")}:{" "}
						{stats.lines.map((ln, i) => (
							<span key={ln}>
								{i > 0 && ", "}
								<Link
									to="/$lang/line/$line"
									params={{ lang: l, line: ln }}
									className="text-accent"
								>
									{ln}
								</Link>
							</span>
						))}
					</p>
				)}
			</SignageHeader>

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
					tone={ghost > 0 ? "info" : undefined}
				/>
				<StatCard label={t(l, "stat.reliability")} value={`${score}%`} />
			</section>

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
					<EmptyState icon="⌛" title={t(l, "table.no_data")} />
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
												className={`py-2 pr-4 text-right tabular-nums font-bold ${ledForScore(dayScore)}`}
											>
												{dayScore}%
											</td>
											<td className="py-2 pr-4 text-right">
												<Link
													to="/$lang/operator/$operator/day/$date"
													params={{
														lang: l,
														operator,
														date: d.date,
													}}
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

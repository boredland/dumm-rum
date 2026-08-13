import { createFileRoute, Link } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { setResponseHeader } from "@tanstack/react-start/server";
import { useState } from "react";
import {
	DaysToggleBar,
	useDaysFilter,
} from "../../../../components/DaysToggle.tsx";
import { EmptyState } from "../../../../components/EmptyState.tsx";
import { Figure, Figures } from "../../../../components/Figures.tsx";
import {
	AlertButton,
	BackLink,
	PageHeader,
} from "../../../../components/PageHeader.tsx";
import { SubscribeModal } from "../../../../components/SubscribeModal.tsx";
import { type Lang, t } from "../../../../lib/i18n.ts";
import { getLineStats, type LineStats } from "../../../../lib/queries.ts";
import { urlFilter } from "../../../../lib/search-state.ts";
import {
	toneForCancRate,
	toneForCount,
	toneForScore,
} from "../../../../lib/status.ts";
import { makeSwr } from "../../../../lib/swr.ts";
import { onTimeRate, parseLineSlug } from "../../../../lib/utils.ts";

const DAYS_FILTER_OPTS = ["all", "today", "weekdays", "weekends"] as const;

const lineSwr = makeSwr<{ line: string; stats: LineStats }>(
	async (line) => ({ line, stats: await getLineStats(line) }),
	{ freshMs: 60_000, staleMs: 15 * 60_000 },
);

const loadLine = createServerFn({ method: "GET" })
	.inputValidator((line: unknown): string => {
		if (typeof line !== "string" || line.length === 0) {
			throw new Error("invalid line");
		}
		return line;
	})
	.handler(async ({ data: line }) => {
		setResponseHeader(
			"Cache-Control",
			"public, max-age=30, s-maxage=60, stale-while-revalidate=900",
		);
		return lineSwr.get(line);
	});

export const Route = createFileRoute("/$lang/line/$line/")({
	staleTime: 5 * 60 * 1000,
	loader: async ({ params }) => await loadLine({ data: params.line }),
	validateSearch: (search: Record<string, unknown>): { days?: string } => ({
		days: typeof search.days === "string" ? search.days : undefined,
	}),
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
	/** `line` is the routing slug (`rmv:U-Bahn:U4`); riders know it as "U4". */
	const lineName = parseLineSlug(line).line;
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
	const [subscribeOpen, setSubscribeOpen] = useState(false);

	// Reduced over the day selection, not every day on record: the figures
	// carry no window of their own, so a reader takes them as describing
	// whatever the toggle below says is selected.
	const shown = daysFilter.filtered;
	const total = shown.reduce((a, d) => a + d.total, 0);
	const canc = shown.reduce((a, d) => a + d.cancelled, 0);
	const ghost = shown.reduce((a, d) => a + d.ghost, 0);
	const delayed = shown.reduce((a, d) => a + d.delayed, 0);
	const score = onTimeRate(canc, delayed, total);
	// A selection can be empty (weekends before the first weekend of
	// collection, "today" before the first poll). onTimeRate answers 100 for
	// zero departures, which would read as a perfect day rather than no
	// data, so the rates render as a dash instead.
	const pctOf = (n: number) =>
		total === 0 ? "—" : `${((n / total) * 100).toFixed(1)}%`;

	return (
		<main className="mx-auto max-w-3xl px-6 py-10 space-y-10">
			<PageHeader
				backLink={
					<Link to="/$lang" params={{ lang: l }}>
						<BackLink>{t(l, "nav.back")}</BackLink>
					</Link>
				}
				title={lineName}
				action={
					<AlertButton
						label={t(l, "subscribe.cta.button")}
						onClick={() => setSubscribeOpen(true)}
					/>
				}
			>
				{stats.destinations.length > 0 && (
					<p>{stats.destinations.join(" – ")}</p>
				)}
				{stats.operators.length > 0 && <p>{stats.operators.join(", ")}</p>}
			</PageHeader>

			{subscribeOpen && (
				<SubscribeModal
					lang={l}
					initial={{ line: lineName }}
					availableDirections={stats.destinations}
					onClose={() => setSubscribeOpen(false)}
				/>
			)}

			<Figures>
				<Figure label={t(l, "stat.departures")} value={String(total)} />
				<Figure
					label={t(l, "home.cancelled")}
					value={pctOf(canc)}
					tone={toneForCancRate(canc / (total || 1))}
				/>
				<Figure
					label={t(l, "home.ghost")}
					value={pctOf(ghost)}
					tone={ghost > 0 ? "text-ghost" : "text-muted"}
				/>
				<Figure
					label={t(l, "stat.reliability")}
					value={total === 0 ? "—" : `${score}%`}
					tone={toneForScore(score)}
				/>
			</Figures>

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
													to="/$lang/line/$line/day/$date"
													params={{ lang: l, line: line, date: d.date }}
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
		</main>
	);
}

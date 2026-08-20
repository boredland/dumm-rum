import { createFileRoute, Link } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { setResponseHeader } from "@tanstack/react-start/server";
import { DailyBreakdown } from "../../../../components/DailyBreakdown.tsx";
import { useDaysFilter } from "../../../../components/DaysToggle.tsx";
import { Figure, Figures } from "../../../../components/Figures.tsx";
import { BackLink, PageHeader } from "../../../../components/PageHeader.tsx";
import { operatorSwr } from "../../../../lib/entity-cache.ts";
import { type Lang, langFromParams, t } from "../../../../lib/i18n.ts";
import { urlFilter } from "../../../../lib/search-state.ts";
import {
	breadcrumbJsonLd,
	entityDescription,
	entityJsonLd,
	entityRoute,
	pageHead,
} from "../../../../lib/seo.ts";
import { toneForCancRate, toneForScore } from "../../../../lib/status.ts";
import { onTimeRate, parseLineSlug } from "../../../../lib/utils.ts";

const DAYS_FILTER_OPTS = ["all", "today", "weekdays", "weekends"] as const;

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
	head: ({ params, loaderData }) => {
		const l = langFromParams(params);
		const name = loaderData?.operator ?? params.operator;
		const route = entityRoute("operator", params.operator);
		const description = entityDescription(
			l,
			"operator",
			name,
			loaderData?.stats.days ?? [],
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
				title={operator}
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
									className="underline decoration-rule hover:decoration-current"
								>
									{parseLineSlug(ln).line}
								</Link>
							</span>
						))}
					</p>
				)}
			</PageHeader>

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

			<DailyBreakdown
				lang={l}
				days={daysFilter.filtered}
				active={daysFilter.active}
				setActive={daysFilter.setActive}
				dayLink={(date) => (
					<Link
						to="/$lang/operator/$operator/day/$date"
						params={{ lang: l, operator, date }}
						className="text-meta text-muted hover:text-ink"
					>
						→
					</Link>
				)}
			/>
		</main>
	);
}

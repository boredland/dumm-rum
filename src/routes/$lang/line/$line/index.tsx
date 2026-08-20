import { createFileRoute, Link } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { setResponseHeader } from "@tanstack/react-start/server";
import { useState } from "react";
import { DailyBreakdown } from "../../../../components/DailyBreakdown.tsx";
import { useDaysFilter } from "../../../../components/DaysToggle.tsx";
import {
	AlertButton,
	BackLink,
	PageHeader,
} from "../../../../components/PageHeader.tsx";
import { SelectionFigures } from "../../../../components/SelectionFigures.tsx";
import { SubscribeModal } from "../../../../components/SubscribeModal.tsx";
import { lineSwr } from "../../../../lib/entity-cache.ts";
import { type Lang, langFromParams, t } from "../../../../lib/i18n.ts";
import { urlFilter } from "../../../../lib/search-state.ts";
import {
	breadcrumbJsonLd,
	entityDescription,
	entityJsonLd,
	entityRoute,
	pageHead,
} from "../../../../lib/seo.ts";
import { parseLineSlug } from "../../../../lib/utils.ts";

const DAYS_FILTER_OPTS = ["all", "today", "weekdays", "weekends"] as const;

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
	head: ({ params, loaderData }) => {
		const l = langFromParams(params);
		const name = parseLineSlug(params.line).line;
		const route = entityRoute("line", params.line);
		const description = entityDescription(
			l,
			"line",
			name,
			loaderData?.stats.days ?? [],
		);
		const title = t(l, "seo.line.title", { name });
		return pageHead({
			lang: l,
			title,
			description,
			route,
			jsonLd: [
				entityJsonLd({ lang: l, name: title, description, route }),
				breadcrumbJsonLd(l, [
					{ name: t(l, "home.title"), route: "" },
					{ name: title, route },
				]),
			],
		});
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

			<SelectionFigures lang={l} days={daysFilter.filtered} />

			<DailyBreakdown
				lang={l}
				days={daysFilter.filtered}
				active={daysFilter.active}
				setActive={daysFilter.setActive}
				dayLink={(date) => (
					<Link
						to="/$lang/line/$line/day/$date"
						params={{ lang: l, line, date }}
						className="text-meta text-muted hover:text-ink"
					>
						→
					</Link>
				)}
			/>
		</main>
	);
}

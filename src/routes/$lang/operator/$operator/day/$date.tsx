import { createFileRoute, Link } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { setResponseHeader } from "@tanstack/react-start/server";
import {
	DepartureFilterBar,
	useDepartureFilters,
} from "../../../../../components/DepartureFilters.tsx";
import { StatusMark } from "../../../../../components/DepartureRow.tsx";
import { EmptyState } from "../../../../../components/EmptyState.tsx";
import { BackLink, PageHeader } from "../../../../../components/PageHeader.tsx";
import { type Lang, langFromParams, t } from "../../../../../lib/i18n.ts";
import {
	getOperatorDayJourneys,
	type OperatorDayJourney,
} from "../../../../../lib/queries.ts";
import { urlFilter, urlStringFilter } from "../../../../../lib/search-state.ts";
import { entityRoute, pageHead } from "../../../../../lib/seo.ts";
import { makeSwr } from "../../../../../lib/swr.ts";
import {
	delayMin,
	formatTime,
	prettyDate,
	shortStationName,
	todayBerlin,
} from "../../../../../lib/utils.ts";

const STATUS_OPTS = ["all", "issues", "on_time"] as const;
const HOURS_OPTS = ["all", "core"] as const;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const operatorDaySwr = makeSwr<OperatorDayJourney[]>(
	(key) => {
		const [operator, date] = key.split("|");
		return getOperatorDayJourneys(operator, date);
	},
	{ freshMs: 60_000, staleMs: 15 * 60_000 },
);

const loadDay = createServerFn({ method: "GET" })
	.inputValidator((input: unknown): { operator: string; date: string } => {
		if (
			typeof input !== "object" ||
			input === null ||
			!("operator" in input) ||
			!("date" in input)
		) {
			throw new Error("invalid input");
		}
		const { operator, date } = input as { operator: unknown; date: unknown };
		if (typeof operator !== "string" || typeof date !== "string") {
			throw new Error("invalid input");
		}
		if (!DATE_RE.test(date)) throw new Error("invalid date");
		return { operator, date };
	})
	.handler(
		async ({
			data: { operator, date },
		}): Promise<{
			operator: string;
			date: string;
			journeys: OperatorDayJourney[];
		}> => {
			const isToday = date === todayBerlin();
			setResponseHeader(
				"Cache-Control",
				isToday
					? "public, max-age=30, s-maxage=60, stale-while-revalidate=900"
					: "public, max-age=3600, s-maxage=86400, stale-while-revalidate=86400, immutable",
			);
			const journeys = await operatorDaySwr.get(`${operator}|${date}`);
			return { operator, date, journeys };
		},
	);

export const Route = createFileRoute("/$lang/operator/$operator/day/$date")({
	loader: async ({ params }) =>
		await loadDay({ data: { operator: params.operator, date: params.date } }),
	head: ({ params }) => {
		const l = langFromParams(params);
		const name = params.operator;
		const date = prettyDate(l, params.date);
		return pageHead({
			lang: l,
			title: t(l, "seo.operator.day", { name, date }),
			description: t(l, "seo.operator.day_description", { name, date }),
			route: `${entityRoute("operator", params.operator)}/day/${params.date}`,
			noindex: true,
		});
	},
	validateSearch: (
		search: Record<string, unknown>,
	): { status?: string; hours?: string; dir?: string } => ({
		status: typeof search.status === "string" ? search.status : undefined,
		hours: typeof search.hours === "string" ? search.hours : undefined,
		dir: typeof search.dir === "string" ? search.dir : undefined,
	}),
	component: OperatorDay,
});

function OperatorDay() {
	const { operator, date, journeys } = Route.useLoaderData();
	const { lang } = Route.useParams();
	const search = Route.useSearch();
	const navigate = Route.useNavigate();
	const l = lang as Lang;
	const setSearch = (patch: Record<string, string | undefined>) =>
		navigate({
			search: (s) => ({ ...s, ...patch }),
			replace: true,
		});
	const [status, setStatus] = urlFilter(
		search.status,
		"all",
		STATUS_OPTS,
		setSearch,
		"status",
	);
	const [hours, setHours] = urlFilter(
		search.hours,
		"all",
		HOURS_OPTS,
		setSearch,
		"hours",
	);
	const [dir, setDir] = urlStringFilter(search.dir, "all", setSearch, "dir");
	const filters = useDepartureFilters(journeys, {
		status: { value: status, onChange: setStatus },
		hours: { value: hours, onChange: setHours },
		dir: { value: dir, onChange: setDir },
	});

	const pretty = prettyDate(l, date);

	return (
		<main className="mx-auto max-w-3xl px-6 py-10 space-y-10">
			<PageHeader
				backLink={
					<Link to="/$lang/operator/$operator" params={{ lang: l, operator }}>
						<BackLink>{operator}</BackLink>
					</Link>
				}
				title={operator}
			>
				<p>{pretty}</p>
			</PageHeader>

			<section className="space-y-4">
				<h2 className="eyebrow text-ink border-b border-ink pb-2">
					{t(l, "section.all_departures")}
				</h2>

				<DepartureFilterBar lang={l} {...filters} />

				{filters.filtered.length === 0 ? (
					<EmptyState title={t(l, "table.no_departures")} />
				) : (
					<div className="overflow-x-auto">
						<table className="report-table report-table--departures">
							<thead>
								<tr>
									<th className="col-time">{t(l, "table.time")}</th>
									<th className="col-line">{t(l, "table.line")}</th>
									<th className="name">{t(l, "table.station")}</th>
									<th className="name">{t(l, "table.direction")}</th>
									<th className="col-status">{t(l, "table.status")}</th>
								</tr>
							</thead>
							<tbody>
								{filters.filtered.map((j) => {
									const delay = delayMin(j.date, j.time, j.rtTime);
									return (
										<tr key={`${j.time}-${j.line}-${j.direction}-${j.stop}`}>
											<td className="figures col-time">
												{formatTime(j.time)}
												{j.rtTime && j.rtTime !== j.time && (
													<span className="rt text-muted">
														→ {formatTime(j.rtTime)}
													</span>
												)}
											</td>
											<td className="figures col-line text-meta text-muted">
												{j.line}
											</td>
											<td className="name" title={j.stop}>
												{shortStationName(j.stop)}
											</td>
											<td className="name" title={j.direction}>
												{shortStationName(j.direction)}
											</td>
											<td>
												<StatusMark
													lang={l}
													cancelled={j.cancelled}
													ghost={j.ghost}
													delayMin={delay}
												/>
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

import { createFileRoute, Link } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { setResponseHeader } from "@tanstack/react-start/server";
import { useEffect, useRef } from "react";
import {
	DepartureFilterBar,
	useDepartureFilters,
} from "../../../../../components/DepartureFilters.tsx";
import { type Lang, t } from "../../../../../lib/i18n.ts";
import {
	getLineDayJourneys,
	type LineDayJourney,
} from "../../../../../lib/queries.ts";
import { urlFilter, urlStringFilter } from "../../../../../lib/search-state.ts";
import { makeSwr } from "../../../../../lib/swr.ts";
import { delayMin, formatTime, todayBerlin } from "../../../../../lib/utils.ts";

const STATUS_OPTS = ["all", "issues", "on_time"] as const;
const HOURS_OPTS = ["all", "core"] as const;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const lineDaySwr = makeSwr<LineDayJourney[]>(
	(key) => {
		const [line, date] = key.split("|");
		return getLineDayJourneys(line, date);
	},
	{ freshMs: 60_000, staleMs: 15 * 60_000 },
);

const loadDay = createServerFn({ method: "GET" })
	.inputValidator((input: unknown): { line: string; date: string } => {
		if (
			typeof input !== "object" ||
			input === null ||
			!("line" in input) ||
			!("date" in input)
		) {
			throw new Error("invalid input");
		}
		const { line, date } = input as { line: unknown; date: unknown };
		if (typeof line !== "string" || typeof date !== "string") {
			throw new Error("invalid input");
		}
		if (!DATE_RE.test(date)) throw new Error("invalid date");
		return { line, date };
	})
	.handler(
		async ({
			data: { line, date },
		}): Promise<{ line: string; date: string; journeys: LineDayJourney[] }> => {
			// Past days are immutable; today keeps accruing rows throughout
			// the day so we keep its edge TTL short.
			const isToday = date === todayBerlin();
			setResponseHeader(
				"Cache-Control",
				isToday
					? "public, max-age=30, s-maxage=60, stale-while-revalidate=900"
					: "public, max-age=3600, s-maxage=86400, stale-while-revalidate=86400, immutable",
			);
			const journeys = await lineDaySwr.get(`${line}|${date}`);
			return { line, date, journeys };
		},
	);

export const Route = createFileRoute("/$lang/line/$line/day/$date")({
	loader: async ({ params }) =>
		await loadDay({ data: { line: params.line, date: params.date } }),
	validateSearch: (
		search: Record<string, unknown>,
	): {
		jid?: string;
		status?: string;
		hours?: string;
		dir?: string;
	} => ({
		jid: typeof search.jid === "string" ? search.jid : undefined,
		status: typeof search.status === "string" ? search.status : undefined,
		hours: typeof search.hours === "string" ? search.hours : undefined,
		dir: typeof search.dir === "string" ? search.dir : undefined,
	}),
	component: LineDay,
});

function LineDay() {
	const { line, date, journeys } = Route.useLoaderData();
	const { lang } = Route.useParams();
	const search = Route.useSearch();
	const navigate = Route.useNavigate();
	const { jid } = search;
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
	const highlightedRowRef = useRef<HTMLTableRowElement | null>(null);

	useEffect(() => {
		if (!jid || !highlightedRowRef.current) return;
		highlightedRowRef.current.scrollIntoView({
			behavior: "smooth",
			block: "center",
		});
	}, [jid]);

	const pretty = new Date(`${date}T00:00:00`).toLocaleDateString(l, {
		weekday: "long",
		year: "numeric",
		month: "long",
		day: "numeric",
	});

	return (
		<main className="mx-auto max-w-4xl p-6 space-y-6">
			<header className="space-y-1">
				<Link
					to="/$lang/line/$line"
					params={{ lang: l, line }}
					className="text-sm text-muted hover:text-fg"
				>
					← {line}
				</Link>
				<h1 className="text-2xl font-bold mt-2">{line}</h1>
				<p className="text-sm text-muted">{pretty}</p>
			</header>

			<section>
				<h2 className="text-xs uppercase tracking-wide text-muted font-semibold mb-3">
					{t(l, "section.all_departures")} ({filters.filtered.length}/
					{journeys.length})
				</h2>

				<DepartureFilterBar lang={l} {...filters} />

				{filters.filtered.length === 0 ? (
					<p className="text-sm text-dimmed">{t(l, "table.no_departures")}</p>
				) : (
					<div className="overflow-x-auto">
						<table className="w-full text-sm">
							<thead>
								<tr className="text-left text-xs uppercase text-muted border-b border-border-dim">
									<th className="py-2 pr-3">{t(l, "table.time")}</th>
									<th className="py-2 pr-3">{t(l, "table.station")}</th>
									<th className="py-2 pr-3">{t(l, "table.direction")}</th>
									<th className="py-2 pr-3">{t(l, "table.status")}</th>
								</tr>
							</thead>
							<tbody>
								{filters.filtered.map((j) => {
									const delay = delayMin(j.date, j.time, j.rtTime);
									const isHighlighted = jid != null && j.journeyRef === jid;
									return (
										<tr
											key={j.journeyRef}
											ref={isHighlighted ? highlightedRowRef : null}
											className={`border-b border-border-dim ${
												isHighlighted
													? "bg-accent/10 outline outline-2 outline-accent/60"
													: ""
											}`}
										>
											<td className="py-2 pr-3 whitespace-nowrap tabular-nums">
												{formatTime(j.time)}
												{j.rtTime && j.rtTime !== j.time && (
													<span className="ml-1 text-dimmed">
														→ {formatTime(j.rtTime)}
													</span>
												)}
											</td>
											<td className="py-2 pr-3 truncate" title={j.stop}>
												{j.stop}
											</td>
											<td className="py-2 pr-3 truncate" title={j.direction}>
												{j.direction}
											</td>
											<td className="py-2 pr-3">
												{j.cancelled ? (
													<span className="text-danger">❌</span>
												) : j.ghost ? (
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
				)}
			</section>
		</main>
	);
}

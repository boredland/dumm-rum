import { createFileRoute, Link } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import {
	DepartureFilterBar,
	useDepartureFilters,
} from "../../../../components/DepartureFilters.tsx";
import { type Lang, t } from "../../../../lib/i18n.ts";
import {
	findStopBySlug,
	getStopDayDepartures,
	type StopDayDeparture,
} from "../../../../lib/queries.ts";
import { categoryIcons } from "../../../../lib/stations.ts";
import {
	delayMin,
	formatTime,
	shortStationName,
} from "../../../../lib/utils.ts";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

interface DayData {
	stopName: string;
	categories: string[];
	date: string;
	departures: StopDayDeparture[];
}

const loadDay = createServerFn({ method: "GET" })
	.inputValidator((input: unknown): { slug: string; date: string } => {
		if (
			typeof input !== "object" ||
			input === null ||
			!("slug" in input) ||
			!("date" in input)
		) {
			throw new Error("invalid input");
		}
		const { slug, date } = input as { slug: unknown; date: unknown };
		if (typeof slug !== "string" || typeof date !== "string") {
			throw new Error("invalid input");
		}
		if (!DATE_RE.test(date)) throw new Error("invalid date");
		return { slug, date };
	})
	.handler(async ({ data: { slug, date } }): Promise<DayData> => {
		const stop = await findStopBySlug(slug);
		if (!stop) throw new Error("not found");
		const departures = await getStopDayDepartures(stop.stopIds, date);
		return {
			stopName: stop.stopName,
			categories: stop.categories,
			date,
			departures,
		};
	});

export const Route = createFileRoute("/$lang/$station/day/$date")({
	loader: async ({ params }) =>
		await loadDay({ data: { slug: params.station, date: params.date } }),
	component: StationDay,
});

function StationDay() {
	const { stopName, categories, date, departures } = Route.useLoaderData();
	const { lang, station } = Route.useParams();
	const l = lang as Lang;
	const filters = useDepartureFilters(departures);

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
					to="/$lang/$station"
					params={{ lang: l, station }}
					className="text-sm text-muted hover:text-fg"
				>
					← {shortStationName(stopName)}
				</Link>
				<h1 className="text-2xl font-bold flex items-center gap-2 mt-2">
					{categoryIcons(categories)} {shortStationName(stopName)}
				</h1>
				<p className="text-sm text-muted">{pretty}</p>
			</header>

			<section>
				<h2 className="text-xs uppercase tracking-wide text-muted font-semibold mb-3">
					{t(l, "section.all_departures")} ({filters.filtered.length}/
					{departures.length})
				</h2>

				<DepartureFilterBar
					lang={l}
					{...filters}
					lines={[...new Set(filters.filtered.map((d) => d.line))].sort()}
				/>

				{filters.filtered.length === 0 ? (
					<p className="text-sm text-dimmed">{t(l, "table.no_departures")}</p>
				) : (
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
								{filters.filtered.map((d, i) => {
									const delay = delayMin(d.date, d.time, d.rtTime);
									const isRail = /^(ICE|IC|EC|RE|RB|S)\s?\d/i.test(d.line);
									const bahnUrl = isRail && delay !== null && delay >= 5
										? `https://bahn.expert/details/${encodeURIComponent(d.line)}/${d.date}T${d.time.replace(/:/g, "%3A")}.000Z`
										: null;
									return (
										<tr
											key={`${i}-${d.time}-${d.line}-${d.direction}`}
											className="border-b border-border-dim"
										>
											<td className="py-2 pr-3 whitespace-nowrap tabular-nums">
												{formatTime(d.time)}
												{d.rtTime && d.rtTime !== d.time && (
													<span className="ml-1 text-dimmed">
														→ {formatTime(d.rtTime)}
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
														{bahnUrl && (
															<a
																href={bahnUrl}
																target="_blank"
																rel="noopener noreferrer"
																className="ml-1 text-accent text-xs"
															>
																why?
															</a>
														)}
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
				)}
			</section>
		</main>
	);
}

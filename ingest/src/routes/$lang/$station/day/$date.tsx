import { createFileRoute, Link } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { useMemo, useState } from "react";
import { type Lang, t } from "../../../../lib/i18n.ts";
import {
	findStopBySlug,
	getStopDayDepartures,
	type StopDayDeparture,
} from "../../../../lib/queries.ts";
import { categoryIcons } from "../../../../lib/stations.ts";
import {
	DELAY_THRESHOLD_MIN,
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

type StatusFilter = "all" | "issues" | "on_time";
type HoursFilter = "all" | "core";

const CORE_HOURS = [
	[6, 9],
	[16, 19],
] as const;

function formatTime(time: string | null): string {
	if (!time) return "—";
	return time.slice(0, 5);
}

function delayMin(
	schedDate: string,
	sched: string,
	rt: string | null,
): number | null {
	if (!rt) return null;
	const planned = new Date(`${schedDate}T${sched}`).getTime();
	const actual = new Date(`${schedDate}T${rt}`).getTime();
	if (!Number.isFinite(planned) || !Number.isFinite(actual)) return null;
	return Math.round((actual - planned) / 60_000);
}

function isIssue(d: StopDayDeparture): boolean {
	if (d.cancelled || d.ghost) return true;
	const delay = delayMin(d.date, d.time, d.rtTime);
	return delay !== null && delay >= DELAY_THRESHOLD_MIN;
}

function isCoreHour(time: string): boolean {
	const h = Number.parseInt(time.slice(0, 2), 10);
	return CORE_HOURS.some(([from, to]) => h >= from && h < to);
}

function StationDay() {
	const { stopName, categories, date, departures } = Route.useLoaderData();
	const { lang, station } = Route.useParams();
	const l = lang as Lang;
	const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
	const [hoursFilter, setHoursFilter] = useState<HoursFilter>("all");
	const [dirFilter, setDirFilter] = useState<string>("all");

	const directions = useMemo(
		() => [...new Set(departures.map((d) => d.direction))].sort(),
		[departures],
	);

	const filtered = useMemo(
		() =>
			departures.filter((d) => {
				if (statusFilter === "issues" && !isIssue(d)) return false;
				if (statusFilter === "on_time" && isIssue(d)) return false;
				if (hoursFilter === "core" && !isCoreHour(d.time)) return false;
				if (dirFilter !== "all" && d.direction !== dirFilter) return false;
				return true;
			}),
		[departures, statusFilter, hoursFilter, dirFilter],
	);

	const pretty = new Date(`${date}T00:00:00`).toLocaleDateString(l, {
		weekday: "long",
		year: "numeric",
		month: "long",
		day: "numeric",
	});

	const pill =
		"px-3 py-1 text-xs font-medium rounded-full border border-border cursor-pointer transition-colors";
	const active = "bg-surface-hover text-fg";
	const inactive = "bg-transparent text-muted hover:text-fg";

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
					{t(l, "section.all_departures")} ({filtered.length}/
					{departures.length})
				</h2>

				<div className="flex flex-wrap gap-x-4 gap-y-2 mb-4">
					<div className="flex gap-2">
						{(
							[
								["issues", t(l, "filter.issues")],
								["all", t(l, "filter.all")],
								["on_time", t(l, "filter.on_time")],
							] as const
						).map(([key, label]) => (
							<button
								key={key}
								type="button"
								onClick={() => setStatusFilter(key)}
								className={`${pill} ${statusFilter === key ? active : inactive}`}
							>
								{label}
							</button>
						))}
					</div>
					<div className="flex gap-2">
						{(
							[
								["all", t(l, "hours.all")],
								["core", t(l, "hours.core")],
							] as const
						).map(([key, label]) => (
							<button
								key={key}
								type="button"
								onClick={() => setHoursFilter(key)}
								className={`${pill} ${hoursFilter === key ? active : inactive}`}
							>
								{label}
							</button>
						))}
					</div>
					{directions.length > 1 && (
						<div className="flex gap-2">
							<select
								value={dirFilter}
								onChange={(e) => setDirFilter(e.target.value)}
								className="bg-surface border border-border rounded-full px-3 py-1 text-xs text-muted cursor-pointer"
							>
								<option value="all">{t(l, "filter.all_directions")}</option>
								{directions.map((dir) => (
									<option key={dir} value={dir}>
										{dir}
									</option>
								))}
							</select>
						</div>
					)}
				</div>

				{filtered.length === 0 ? (
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
								{filtered.map((d) => {
									const delay = delayMin(d.date, d.time, d.rtTime);
									return (
										<tr
											key={`${d.time}-${d.line}-${d.direction}`}
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

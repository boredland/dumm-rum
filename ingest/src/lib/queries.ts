import {
	and,
	asc,
	count,
	desc,
	eq,
	gte,
	inArray,
	isNotNull,
	sql,
	sum,
} from "drizzle-orm";
import { db } from "../db/client.ts";
import {
	journeyRuns,
	journeyStops,
	knownStops,
	lineDailyStats,
	operatorDailyStats,
} from "../db/schema.ts";
import {
	DELAY_THRESHOLD_MIN,
	PLANNED_FREQUENCY_MIN,
	todayBerlin,
} from "./utils.ts";

// Reusable SQL fragments (mirror of materialize.ts helpers — Postgres
// boolean-aware; epoch math for delay minutes).
const ghostStopCaseSql = sql<number>`CASE WHEN NOT ${journeyRuns.wasTracked} AND NOT ${journeyRuns.cancelled} THEN 1 ELSE 0 END`;

const stopDelayMinSql = sql<number>`
	EXTRACT(EPOCH FROM (
		(${journeyStops.dayOfOperation} || ' ' || ${journeyStops.rtDepTime})::timestamp
		- (${journeyStops.dayOfOperation} || ' ' || ${journeyStops.depTime})::timestamp
	)) / 60.0
`;

export type DaysFilter = "all" | "today" | "weekdays" | "weekends";

export interface QueryFilter {
	days?: DaysFilter;
}

/** Build a SQL condition for the `date` column of a rollup table. */
function daysCondition(
	dateCol: typeof operatorDailyStats.date | typeof lineDailyStats.date,
	filter: DaysFilter = "today",
) {
	if (filter === "today") return eq(dateCol, todayBerlin());
	// Postgres text-date → DOW. EXTRACT(DOW FROM ::date) → 0..6 with Sunday=0.
	if (filter === "weekdays")
		return sql`EXTRACT(DOW FROM ${dateCol}::date)::int NOT IN (0, 6)`;
	if (filter === "weekends")
		return sql`EXTRACT(DOW FROM ${dateCol}::date)::int IN (0, 6)`;
	return undefined; // "all" — no filter
}

const VALID_DAYS = new Set<DaysFilter>([
	"all",
	"today",
	"weekdays",
	"weekends",
]);

export function parseFilter(url: URL): QueryFilter {
	const days = url.searchParams.get("days") ?? "today";
	return {
		days: VALID_DAYS.has(days as DaysFilter) ? (days as DaysFilter) : "today",
	};
}

export interface OperatorSummary {
	operator: string;
	lines: string[];
	categories: string[];
	total: number;
	cancelled: number;
	ghost: number;
	delayed: number;
	avgDelay: number | null;
}

export async function getOperatorSummaries(
	filter: QueryFilter = {},
): Promise<OperatorSummary[]> {
	const daysCond = daysCondition(operatorDailyStats.date, filter.days);

	const [statsRows, lineRows] = await Promise.all([
		db
			.select({
				operator: operatorDailyStats.operator,
				total: sum(operatorDailyStats.total).as("total"),
				cancelled: sum(operatorDailyStats.cancelled).as("cancelled"),
				ghost: sum(operatorDailyStats.ghost).as("ghost"),
				delayed: sum(operatorDailyStats.delayed).as("delayed"),
				// Weighted average of per-day avg_delay by per-day total.
				avgDelay: sql<number | null>`
					SUM(${operatorDailyStats.avgDelay} * ${operatorDailyStats.total})
					/ NULLIF(SUM(CASE WHEN ${operatorDailyStats.avgDelay} IS NOT NULL THEN ${operatorDailyStats.total} END), 0)
				`.as("avg_delay"),
			})
			.from(operatorDailyStats)
			.where(daysCond)
			.groupBy(operatorDailyStats.operator),
		db
			.selectDistinct({
				operator: journeyRuns.operator,
				line: journeyRuns.line,
				category: journeyRuns.category,
			})
			.from(journeyRuns)
			.where(
				and(
					isNotNull(journeyRuns.operator),
					gte(
						journeyRuns.dayOfOperation,
						sql`to_char(CURRENT_DATE - INTERVAL '30 days', 'YYYY-MM-DD')`,
					),
				),
			)
			.orderBy(journeyRuns.operator, journeyRuns.line),
	]);

	const lineMap = new Map<string, string[]>();
	const catMap = new Map<string, Set<string>>();
	for (const row of lineRows) {
		if (!row.operator) continue;
		const lines = lineMap.get(row.operator) ?? [];
		lines.push(row.line);
		lineMap.set(row.operator, lines);
		if (row.category) {
			const cats = catMap.get(row.operator) ?? new Set();
			cats.add(row.category);
			catMap.set(row.operator, cats);
		}
	}

	return statsRows.map((r) => ({
		operator: r.operator,
		lines: lineMap.get(r.operator) ?? [],
		categories: [...(catMap.get(r.operator) ?? [])],
		total: Number(r.total ?? 0),
		cancelled: Number(r.cancelled ?? 0),
		ghost: Number(r.ghost ?? 0),
		delayed: Number(r.delayed ?? 0),
		avgDelay: r.avgDelay === null ? null : Number(r.avgDelay),
	}));
}

export interface LineSummary {
	line: string;
	category: string;
	operators: string[];
	destinations: string[];
	total: number;
	cancelled: number;
	ghost: number;
	delayed: number;
	avgDelay: number | null;
}

export async function getLineSummaries(
	filter: QueryFilter = {},
): Promise<LineSummary[]> {
	const daysCond = daysCondition(lineDailyStats.date, filter.days);
	const rows = await db
		.select({
			line: lineDailyStats.line,
			category: lineDailyStats.category,
			operators:
				sql<string>`STRING_AGG(DISTINCT ${lineDailyStats.operators}, ',')`.as(
					"operators",
				),
			destinations:
				sql<string>`STRING_AGG(DISTINCT ${lineDailyStats.destinations}, ',')`.as(
					"destinations",
				),
			total: sum(lineDailyStats.total).as("total"),
			cancelled: sum(lineDailyStats.cancelled).as("cancelled"),
			ghost: sum(lineDailyStats.ghost).as("ghost"),
			delayed: sum(lineDailyStats.delayed).as("delayed"),
			avgDelay: sql<number | null>`
				SUM(${lineDailyStats.avgDelay} * ${lineDailyStats.total})
				/ NULLIF(SUM(CASE WHEN ${lineDailyStats.avgDelay} IS NOT NULL THEN ${lineDailyStats.total} END), 0)
			`.as("avg_delay"),
		})
		.from(lineDailyStats)
		.where(daysCond)
		.groupBy(lineDailyStats.line, lineDailyStats.category)
		.orderBy(lineDailyStats.category, lineDailyStats.line);

	return rows.map((r) => ({
		line: r.line,
		category: r.category ?? "Bus",
		operators: r.operators ? dedupeCsv(r.operators) : [],
		destinations: r.destinations ? dedupeCsv(r.destinations) : [],
		total: Number(r.total ?? 0),
		cancelled: Number(r.cancelled ?? 0),
		ghost: Number(r.ghost ?? 0),
		delayed: Number(r.delayed ?? 0),
		avgDelay: r.avgDelay === null ? null : Number(r.avgDelay),
	}));
}

export interface StopSummary {
	stopIds: string[];
	stopName: string;
	journeyCount: number;
	cancelled: number;
	ghost: number;
	delayed: number;
	lines: string[];
	categories: string[];
}

/** Today's-only stop summaries, grouped by name so duplicate stop_ids collapse. */
export async function getStopSummaries(): Promise<StopSummary[]> {
	const rows = await db
		.select({
			stopIds: sql<string>`STRING_AGG(DISTINCT ${knownStops.stopId}, ',')`.as(
				"stop_ids",
			),
			stopName: knownStops.stopName,
			journeyCount: sql<number>`SUM(${knownStops.journeyCount})`.as(
				"journey_count",
			),
			cancelled: sql<number>`SUM(${knownStops.cancelled})`.as("cancelled"),
			ghost: sql<number>`SUM(${knownStops.ghost})`.as("ghost"),
			delayed: sql<number>`SUM(${knownStops.delayed})`.as("delayed"),
			lines: sql<string>`STRING_AGG(DISTINCT ${knownStops.lines}, ',')`.as(
				"lines",
			),
			categories:
				sql<string>`STRING_AGG(DISTINCT ${knownStops.categories}, ',')`.as(
					"categories",
				),
		})
		.from(knownStops)
		.groupBy(knownStops.stopName)
		.orderBy(desc(sql`SUM(${knownStops.journeyCount})`));

	return rows.map((r) => ({
		stopIds: r.stopIds ? r.stopIds.split(",") : [],
		stopName: r.stopName,
		journeyCount: Number(r.journeyCount ?? 0),
		cancelled: Number(r.cancelled ?? 0),
		ghost: Number(r.ghost ?? 0),
		delayed: Number(r.delayed ?? 0),
		lines: r.lines ? dedupeCsv(r.lines) : [],
		categories: r.categories ? dedupeCsv(r.categories) : [],
	}));
}

/** Our STRING_AGG calls can produce nested commas (the underlying column is
 * itself a comma-separated list built by the materialize job). Split + unique. */
function dedupeCsv(s: string): string[] {
	return [...new Set(s.split(","))].filter(Boolean);
}

export interface KnownStop {
	stopIds: string[];
	stopName: string;
	categories: string[];
}

/**
 * Given a station slug, resolve to the set of stop_ids sharing that slug.
 * Multiple stop_ids can map to the same station name (e.g. separate
 * platforms numbered differently in HAFAS but representing the same stop).
 */
export async function findStopBySlug(slug: string): Promise<KnownStop | null> {
	const rows = await db
		.select({
			stopId: knownStops.stopId,
			stopName: knownStops.stopName,
			categories: knownStops.categories,
		})
		.from(knownStops)
		.where(eq(knownStops.slug, slug));

	if (rows.length === 0) return null;

	const categories = new Set<string>();
	for (const r of rows) {
		if (r.categories)
			for (const c of r.categories.split(",")) categories.add(c);
	}

	return {
		stopIds: rows.map((r) => r.stopId),
		stopName: rows[0].stopName,
		categories: [...categories].filter(Boolean),
	};
}

export interface DayStats {
	date: string;
	total: number;
	cancelled: number;
	ghost: number;
	delayed: number;
	avgDelay: number | null;
}

export interface StopStats {
	days: DayStats[];
	lastChange: string | null;
	categories: string[];
}

/**
 * Per-day stats for a station, joining stops→runs so we can count ghosts
 * (runs that never got realtime data). Returns one row per day_of_operation,
 * newest first.
 */
export async function getStopStats(stopIds: string[]): Promise<StopStats> {
	if (stopIds.length === 0) {
		return { days: [], lastChange: null, categories: [] };
	}

	const [dayRows, metaRows] = await Promise.all([
		db
			.select({
				date: journeyStops.dayOfOperation,
				total: count().as("total"),
				cancelled:
					sql<number>`SUM(CASE WHEN ${journeyStops.cancelled} THEN 1 ELSE 0 END)`.as(
						"cancelled",
					),
				ghost: sql<number>`SUM(${ghostStopCaseSql})`.as("ghost"),
				delayed: sql<number>`
					SUM(CASE WHEN NOT ${journeyStops.cancelled}
						AND ${journeyStops.rtDepTime} IS NOT NULL
						AND ${journeyStops.depTime} IS NOT NULL
						AND ${stopDelayMinSql} >= ${DELAY_THRESHOLD_MIN}
					THEN 1 ELSE 0 END)
				`.as("delayed"),
				avgDelay: sql<number | null>`
					AVG(CASE
						WHEN ${journeyStops.cancelled} THEN ${PLANNED_FREQUENCY_MIN}
						WHEN ${journeyStops.rtDepTime} IS NOT NULL AND ${journeyStops.depTime} IS NOT NULL THEN ${stopDelayMinSql}
					END)
				`.as("avg_delay"),
			})
			.from(journeyStops)
			.innerJoin(
				journeyRuns,
				and(
					eq(journeyRuns.journeyRef, journeyStops.journeyRef),
					eq(journeyRuns.dayOfOperation, journeyStops.dayOfOperation),
				),
			)
			.where(inArray(journeyStops.stopId, stopIds))
			.groupBy(journeyStops.dayOfOperation)
			.orderBy(desc(journeyStops.dayOfOperation)),
		db
			.select({
				lastChange: sql<string | null>`MAX(${journeyRuns.snapshotAt})`.as(
					"last_change",
				),
				categories:
					sql<string>`STRING_AGG(DISTINCT ${journeyRuns.category}, ',')`.as(
						"categories",
					),
			})
			.from(journeyStops)
			.innerJoin(
				journeyRuns,
				and(
					eq(journeyRuns.journeyRef, journeyStops.journeyRef),
					eq(journeyRuns.dayOfOperation, journeyStops.dayOfOperation),
				),
			)
			.where(inArray(journeyStops.stopId, stopIds)),
	]);

	const meta = metaRows[0];
	return {
		days: dayRows.map((d) => ({
			date: d.date,
			total: Number(d.total),
			cancelled: Number(d.cancelled),
			ghost: Number(d.ghost),
			delayed: Number(d.delayed),
			avgDelay: d.avgDelay === null ? null : Number(d.avgDelay),
		})),
		lastChange: meta?.lastChange ?? null,
		categories: meta?.categories ? dedupeCsv(meta.categories) : [],
	};
}

export interface LineDayStats {
	date: string;
	total: number;
	cancelled: number;
	ghost: number;
	delayed: number;
	avgDelay: number | null;
}

export interface LineStats {
	days: LineDayStats[];
	operators: string[];
	categories: string[];
}

/** Per-day stats + distinct operators/categories for one line. */
export async function getLineStats(line: string): Promise<LineStats> {
	const rows = await db
		.select()
		.from(lineDailyStats)
		.where(eq(lineDailyStats.line, line))
		.orderBy(desc(lineDailyStats.date));

	const operators = new Set<string>();
	const categories = new Set<string>();
	for (const r of rows) {
		if (r.operators) for (const op of r.operators.split(",")) operators.add(op);
		if (r.category) categories.add(r.category);
	}

	return {
		days: rows.map((d) => ({
			date: d.date,
			total: d.total,
			cancelled: d.cancelled,
			ghost: d.ghost,
			delayed: d.delayed,
			avgDelay: d.avgDelay === null ? null : Number(d.avgDelay),
		})),
		operators: [...operators].filter(Boolean),
		categories: [...categories].filter(Boolean),
	};
}

export interface LineDayJourney {
	date: string;
	time: string;
	rtTime: string | null;
	direction: string;
	cancelled: boolean;
	ghost: number;
	operator: string | null;
	category: string | null;
	stop: string;
}

/** Individual journeys on a line on a given day, ordered by scheduled
 * origin dep time + destination. Origin's rt_dep_time from journey_stops
 * joined in as a correlated subquery. */
export async function getLineDayJourneys(
	line: string,
	date: string,
): Promise<LineDayJourney[]> {
	const rows = await db
		.select({
			date: journeyRuns.dayOfOperation,
			time: journeyRuns.originDepTime,
			rtTime: sql<string | null>`(
				SELECT js.rt_dep_time FROM journey_stops js
				WHERE js.journey_ref = "journey_runs"."journey_ref"
				AND js.day_of_operation = "journey_runs"."day_of_operation"
				AND js.route_idx = 0
			)`.as("rt_time"),
			direction: journeyRuns.destName,
			cancelled: journeyRuns.cancelled,
			ghost:
				sql<number>`CASE WHEN NOT ${journeyRuns.wasTracked} AND NOT ${journeyRuns.cancelled} THEN 1 ELSE 0 END`.as(
					"ghost",
				),
			operator: journeyRuns.operator,
			category: journeyRuns.category,
			stop: journeyRuns.originName,
		})
		.from(journeyRuns)
		.where(
			and(eq(journeyRuns.line, line), eq(journeyRuns.dayOfOperation, date)),
		)
		.orderBy(asc(journeyRuns.originDepTime), asc(journeyRuns.destName));

	return rows.map((r) => ({
		date: r.date,
		time: r.time,
		rtTime: r.rtTime,
		direction: r.direction,
		cancelled: r.cancelled,
		ghost: Number(r.ghost),
		operator: r.operator,
		category: r.category,
		stop: r.stop,
	}));
}

export interface StopDayDeparture {
	date: string;
	time: string;
	rtTime: string | null;
	line: string;
	direction: string;
	cancelled: boolean;
	ghost: number;
}

/** Ordered list of all observed departures at a station on a given day. */
export async function getStopDayDepartures(
	stopIds: string[],
	date: string,
): Promise<StopDayDeparture[]> {
	if (stopIds.length === 0) return [];
	const rows = await db
		.select({
			date: journeyStops.dayOfOperation,
			time: sql<string>`COALESCE(${journeyStops.depTime}, ${journeyStops.arrTime})`.as(
				"time",
			),
			rtTime: sql<
				string | null
			>`COALESCE(${journeyStops.rtDepTime}, ${journeyStops.rtArrTime})`.as(
				"rt_time",
			),
			line: journeyRuns.line,
			direction: journeyRuns.destName,
			cancelled: journeyStops.cancelled,
			ghost: ghostStopCaseSql.as("ghost"),
		})
		.from(journeyStops)
		.innerJoin(
			journeyRuns,
			and(
				eq(journeyRuns.journeyRef, journeyStops.journeyRef),
				eq(journeyRuns.dayOfOperation, journeyStops.dayOfOperation),
			),
		)
		.where(
			and(
				inArray(journeyStops.stopId, stopIds),
				eq(journeyStops.dayOfOperation, date),
			),
		)
		.orderBy(asc(sql`time`), asc(journeyRuns.line));

	return rows.map((r) => ({
		date: r.date,
		time: r.time,
		rtTime: r.rtTime,
		line: r.line,
		direction: r.direction,
		cancelled: r.cancelled,
		ghost: Number(r.ghost),
	}));
}

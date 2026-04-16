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
} from "drizzle-orm";
import { db } from "../db/client.ts";
import { journeyRuns, journeyStops, knownStops } from "../db/schema.ts";
import {
	DELAY_THRESHOLD_MIN,
	PLANNED_FREQUENCY_MIN,
	todayBerlin,
} from "./utils.ts";

// Reusable SQL fragments — Postgres boolean-aware.
const ghostCaseSql = sql<number>`CASE WHEN NOT ${journeyRuns.wasTracked} AND NOT ${journeyRuns.cancelled} THEN 1 ELSE 0 END`;

const stopDelayMinSql = sql<number>`
	EXTRACT(EPOCH FROM (
		(${journeyStops.dayOfOperation} || ' ' || ${journeyStops.rtDepTime})::timestamp
		- (${journeyStops.dayOfOperation} || ' ' || ${journeyStops.depTime})::timestamp
	)) / 60.0
`;

// A journey counts as "delayed" if any of its stops has rtDepTime - depTime >= threshold.
const delayedExistsSql = sql<number>`
	CASE WHEN NOT ${journeyRuns.cancelled} AND EXISTS (
		SELECT 1 FROM journey_stops js
		WHERE js.journey_ref = "journey_runs"."journey_ref"
		AND js.day_of_operation = "journey_runs"."day_of_operation"
		AND js.rt_dep_time IS NOT NULL AND js.dep_time IS NOT NULL
		AND EXTRACT(EPOCH FROM (
			(js.day_of_operation || ' ' || js.rt_dep_time)::timestamp
			- (js.day_of_operation || ' ' || js.dep_time)::timestamp
		)) / 60.0 >= ${DELAY_THRESHOLD_MIN}
	) THEN 1 ELSE 0 END
`;

// Per-run avg delay from the origin stop (route_idx=0). Cancelled →
// assume PLANNED_FREQUENCY_MIN wait.
const runAvgDelaySql = sql<number | null>`
	CASE WHEN ${journeyRuns.cancelled} THEN ${PLANNED_FREQUENCY_MIN} ELSE (
		SELECT EXTRACT(EPOCH FROM (
			(js.day_of_operation || ' ' || js.rt_dep_time)::timestamp
			- (js.day_of_operation || ' ' || js.dep_time)::timestamp
		)) / 60.0
		FROM journey_stops js
		WHERE js.journey_ref = "journey_runs"."journey_ref"
		AND js.day_of_operation = "journey_runs"."day_of_operation"
		AND js.rt_dep_time IS NOT NULL AND js.dep_time IS NOT NULL
		AND js.route_idx = 0
	) END
`;

export type DaysFilter = "all" | "today" | "weekdays" | "weekends";

export interface QueryFilter {
	days?: DaysFilter;
}

function daysCondition(filter: DaysFilter = "today") {
	if (filter === "today") return eq(journeyRuns.dayOfOperation, todayBerlin());
	if (filter === "weekdays")
		return sql`EXTRACT(DOW FROM ${journeyRuns.dayOfOperation}::date)::int NOT IN (0, 6)`;
	if (filter === "weekends")
		return sql`EXTRACT(DOW FROM ${journeyRuns.dayOfOperation}::date)::int IN (0, 6)`;
	return undefined;
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

// ─── Operator summaries ────────────────────────────────────────────────

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
	const daysCond = daysCondition(filter.days);
	const where = and(isNotNull(journeyRuns.operator), daysCond);

	const [statsRows, lineRows] = await Promise.all([
		db
			.select({
				operator: journeyRuns.operator,
				total: count().as("total"),
				cancelled:
					sql<number>`SUM(CASE WHEN ${journeyRuns.cancelled} THEN 1 ELSE 0 END)`.as(
						"cancelled",
					),
				ghost: sql<number>`SUM(${ghostCaseSql})`.as("ghost"),
				delayed: sql<number>`SUM(${delayedExistsSql})`.as("delayed"),
				avgDelay: sql<number | null>`AVG(${runAvgDelaySql})`.as("avg_delay"),
			})
			.from(journeyRuns)
			.where(where)
			.groupBy(journeyRuns.operator),
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
		operator: r.operator as string,
		lines: lineMap.get(r.operator as string) ?? [],
		categories: [...(catMap.get(r.operator as string) ?? [])],
		total: Number(r.total),
		cancelled: Number(r.cancelled),
		ghost: Number(r.ghost),
		delayed: Number(r.delayed),
		avgDelay: r.avgDelay === null ? null : Number(r.avgDelay),
	}));
}

// ─── Line summaries ────────────────────────────────────────────────────

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
	const daysCond = daysCondition(filter.days);
	const rows = await db
		.select({
			line: journeyRuns.line,
			category: sql<string | null>`MAX(${journeyRuns.category})`.as("category"),
			total: count().as("total"),
			cancelled:
				sql<number>`SUM(CASE WHEN ${journeyRuns.cancelled} THEN 1 ELSE 0 END)`.as(
					"cancelled",
				),
			ghost: sql<number>`SUM(${ghostCaseSql})`.as("ghost"),
			delayed: sql<number>`SUM(${delayedExistsSql})`.as("delayed"),
			avgDelay: sql<number | null>`AVG(${runAvgDelaySql})`.as("avg_delay"),
			operators:
				sql<string>`STRING_AGG(DISTINCT ${journeyRuns.operator}, ',')`.as(
					"operators",
				),
			destinations:
				sql<string>`STRING_AGG(DISTINCT ${journeyRuns.destName}, ',')`.as(
					"destinations",
				),
		})
		.from(journeyRuns)
		.where(daysCond)
		.groupBy(journeyRuns.line)
		.orderBy(sql`MAX(${journeyRuns.category})`, journeyRuns.line);

	return rows.map((r) => ({
		line: r.line,
		category: r.category ?? "Bus",
		operators: r.operators ? dedupeCsv(r.operators) : [],
		destinations: r.destinations ? dedupeCsv(r.destinations) : [],
		total: Number(r.total),
		cancelled: Number(r.cancelled),
		ghost: Number(r.ghost),
		delayed: Number(r.delayed),
		avgDelay: r.avgDelay === null ? null : Number(r.avgDelay),
	}));
}

// ─── Stop summaries ────────────────────────────────────────────────────

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

/** Ad-hoc aggregation of journey_stops for the last 7 days, grouped by stop name. */
export async function getStopSummaries(): Promise<StopSummary[]> {
	const rows = await db
		.select({
			stopIds: sql<string>`STRING_AGG(DISTINCT ${journeyStops.stopId}, ',')`.as(
				"stop_ids",
			),
			stopName: sql<string>`MIN(${journeyStops.stopName})`.as("stop_name"),
			journeyCount:
				sql<number>`COUNT(DISTINCT ${journeyStops.journeyRef} || '|' || ${journeyStops.dayOfOperation})`.as(
					"journey_count",
				),
			cancelled:
				sql<number>`SUM(CASE WHEN ${journeyStops.cancelled} THEN 1 ELSE 0 END)`.as(
					"cancelled",
				),
			ghost: sql<number>`SUM(${ghostCaseSql})`.as("ghost"),
			delayed: sql<number>`SUM(CASE WHEN NOT ${journeyStops.cancelled}
				AND ${journeyStops.rtDepTime} IS NOT NULL
				AND ${journeyStops.depTime} IS NOT NULL
				AND ${stopDelayMinSql} >= ${DELAY_THRESHOLD_MIN}
			THEN 1 ELSE 0 END)`.as("delayed"),
			lines: sql<string>`STRING_AGG(DISTINCT ${journeyRuns.line}, ',')`.as(
				"lines",
			),
			categories:
				sql<string>`STRING_AGG(DISTINCT ${journeyRuns.category}, ',')`.as(
					"categories",
				),
		})
		.from(journeyStops)
		.leftJoin(
			journeyRuns,
			and(
				eq(journeyRuns.journeyRef, journeyStops.journeyRef),
				eq(journeyRuns.dayOfOperation, journeyStops.dayOfOperation),
			),
		)
		.where(
			gte(
				journeyStops.dayOfOperation,
				sql`to_char(CURRENT_DATE - INTERVAL '7 days', 'YYYY-MM-DD')`,
			),
		)
		.groupBy(journeyStops.stopId)
		.orderBy(
			desc(
				sql`COUNT(DISTINCT ${journeyStops.journeyRef} || '|' || ${journeyStops.dayOfOperation})`,
			),
		);

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

// ─── Line stats + day journeys ─────────────────────────────────────────

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
	destinations: string[];
}

/** Per-day stats for one line, ad-hoc from journey_runs. */
export async function getLineStats(line: string): Promise<LineStats> {
	const rows = await db
		.select({
			date: journeyRuns.dayOfOperation,
			total: count().as("total"),
			cancelled:
				sql<number>`SUM(CASE WHEN ${journeyRuns.cancelled} THEN 1 ELSE 0 END)`.as(
					"cancelled",
				),
			ghost: sql<number>`SUM(${ghostCaseSql})`.as("ghost"),
			delayed: sql<number>`SUM(${delayedExistsSql})`.as("delayed"),
			avgDelay: sql<number | null>`AVG(${runAvgDelaySql})`.as("avg_delay"),
		})
		.from(journeyRuns)
		.where(eq(journeyRuns.line, line))
		.groupBy(journeyRuns.dayOfOperation)
		.orderBy(desc(journeyRuns.dayOfOperation));

	const [opRows, catRows, destRows] = await Promise.all([
		db
			.selectDistinct({ operator: journeyRuns.operator })
			.from(journeyRuns)
			.where(and(eq(journeyRuns.line, line), isNotNull(journeyRuns.operator))),
		db
			.selectDistinct({ category: journeyRuns.category })
			.from(journeyRuns)
			.where(and(eq(journeyRuns.line, line), isNotNull(journeyRuns.category))),
		db
			.selectDistinct({ dest: journeyRuns.destName })
			.from(journeyRuns)
			.where(eq(journeyRuns.line, line)),
	]);

	return {
		days: rows.map((d) => ({
			date: d.date,
			total: Number(d.total),
			cancelled: Number(d.cancelled),
			ghost: Number(d.ghost),
			delayed: Number(d.delayed),
			avgDelay: d.avgDelay === null ? null : Number(d.avgDelay),
		})),
		operators: opRows.map((r) => r.operator).filter((o): o is string => !!o),
		categories: catRows.map((r) => r.category).filter((c): c is string => !!c),
		destinations: destRows.map((r) => r.dest).filter(Boolean),
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
			ghost: sql<number>`${ghostCaseSql}`.as("ghost"),
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
		...r,
		ghost: Number(r.ghost),
	}));
}

// ─── Operator stats + day journeys ─────────────────────────────────────

export interface OperatorDayStats {
	date: string;
	total: number;
	cancelled: number;
	ghost: number;
	delayed: number;
	avgDelay: number | null;
}

export interface OperatorStats {
	days: OperatorDayStats[];
	lines: string[];
	categories: string[];
}

export async function getOperatorStats(
	operator: string,
): Promise<OperatorStats> {
	const rows = await db
		.select({
			date: journeyRuns.dayOfOperation,
			total: count().as("total"),
			cancelled:
				sql<number>`SUM(CASE WHEN ${journeyRuns.cancelled} THEN 1 ELSE 0 END)`.as(
					"cancelled",
				),
			ghost: sql<number>`SUM(${ghostCaseSql})`.as("ghost"),
			delayed: sql<number>`SUM(${delayedExistsSql})`.as("delayed"),
			avgDelay: sql<number | null>`AVG(${runAvgDelaySql})`.as("avg_delay"),
		})
		.from(journeyRuns)
		.where(eq(journeyRuns.operator, operator))
		.groupBy(journeyRuns.dayOfOperation)
		.orderBy(desc(journeyRuns.dayOfOperation));

	const [lineRows, catRows] = await Promise.all([
		db
			.selectDistinct({ line: journeyRuns.line })
			.from(journeyRuns)
			.where(eq(journeyRuns.operator, operator))
			.orderBy(journeyRuns.line),
		db
			.selectDistinct({ category: journeyRuns.category })
			.from(journeyRuns)
			.where(
				and(
					eq(journeyRuns.operator, operator),
					isNotNull(journeyRuns.category),
				),
			),
	]);

	return {
		days: rows.map((d) => ({
			date: d.date,
			total: Number(d.total),
			cancelled: Number(d.cancelled),
			ghost: Number(d.ghost),
			delayed: Number(d.delayed),
			avgDelay: d.avgDelay === null ? null : Number(d.avgDelay),
		})),
		lines: lineRows.map((r) => r.line),
		categories: catRows.map((r) => r.category).filter((c): c is string => !!c),
	};
}

export interface OperatorDayJourney {
	date: string;
	time: string;
	rtTime: string | null;
	line: string;
	category: string | null;
	direction: string;
	cancelled: boolean;
	ghost: number;
	stop: string;
}

export async function getOperatorDayJourneys(
	operator: string,
	date: string,
): Promise<OperatorDayJourney[]> {
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
			line: journeyRuns.line,
			category: journeyRuns.category,
			direction: journeyRuns.destName,
			cancelled: journeyRuns.cancelled,
			ghost: sql<number>`${ghostCaseSql}`.as("ghost"),
			stop: journeyRuns.originName,
		})
		.from(journeyRuns)
		.where(
			and(
				eq(journeyRuns.operator, operator),
				eq(journeyRuns.dayOfOperation, date),
			),
		)
		.orderBy(
			asc(journeyRuns.originDepTime),
			asc(journeyRuns.line),
			asc(journeyRuns.destName),
		);

	return rows.map((r) => ({
		...r,
		ghost: Number(r.ghost),
	}));
}

// ─── Stop queries (slug resolution + stats + departures) ───────────────

export interface KnownStop {
	stopIds: string[];
	stopName: string;
	categories: string[];
}

/** Resolve a URL slug to stop_ids. Uses known_stops for the slug column. */
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
				ghost: sql<number>`SUM(${ghostCaseSql})`.as("ghost"),
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

export interface StopDayDeparture {
	date: string;
	time: string;
	rtTime: string | null;
	line: string;
	direction: string;
	cancelled: boolean;
	ghost: number;
}

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
			ghost: sql<number>`${ghostCaseSql}`.as("ghost"),
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

function dedupeCsv(s: string): string[] {
	return [...new Set(s.split(","))].filter(Boolean);
}

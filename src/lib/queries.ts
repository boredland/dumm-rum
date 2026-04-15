import type { InferSelectModel } from "drizzle-orm";
import { and, count, desc, eq, gte, isNotNull, sql, sum } from "drizzle-orm";
import type { Db } from "../db/client";
import { sqlIdList } from "../db/helpers";
import {
	haikus,
	journeyRuns,
	journeyStops,
	knownStops,
	lineDailyStats,
	operatorDailyStats,
} from "../db/schema";
import {
	DELAY_THRESHOLD_MIN,
	PLANNED_FREQUENCY_MIN,
	todayBerlin,
} from "./utils";

export const ghostCaseSql = sql<number>`CASE WHEN ${journeyRuns.wasTracked} = 0 AND ${journeyRuns.cancelled} = 0 THEN 1 ELSE 0 END`;

export type DaysFilter = "" | "all" | "today" | "weekdays" | "weekends";

function daysCondition(dateCol: unknown, filter: DaysFilter = "") {
	if (filter === "today")
		return eq(dateCol as typeof lineDailyStats.date, todayBerlin());
	if (filter === "weekdays")
		return sql`strftime('%w', ${dateCol}) NOT IN ('0', '6')`;
	if (filter === "weekends")
		return sql`strftime('%w', ${dateCol}) IN ('0', '6')`;
	return undefined;
}

const validDays = new Set<DaysFilter>([
	"",
	"all",
	"today",
	"weekdays",
	"weekends",
]);

export function parseFilter(url: URL): QueryFilter {
	const days = url.searchParams.get("days") ?? "today";
	return {
		days: validDays.has(days as DaysFilter) ? (days as DaysFilter) : "today",
	};
}

export interface QueryFilter {
	days?: DaysFilter;
}

export interface DayStats {
	date: string;
	total: number;
	cancelled: number;
	ghost: number;
	delayed: number;
	avgDelay: number | null;
}

export interface Stats {
	days: DayStats[];
	lastChange: string | null;
	haiku: string | null;
	categories: string[];
}

export async function getHaiku(
	db: Db,
	date: string,
	lang = "en",
): Promise<string | null> {
	const rows = await db
		.select({ haiku: haikus.haiku, haikuDe: haikus.haikuDe })
		.from(haikus)
		.where(eq(haikus.date, date))
		.limit(1);
	if (!rows[0]) return null;
	return (lang === "de" ? rows[0].haikuDe : null) ?? rows[0].haiku;
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
	db: Db,
	filter: QueryFilter = {},
): Promise<OperatorSummary[]> {
	const opDaysCond = daysCondition(operatorDailyStats.date, filter.days);

	const [statsRows, lineRows] = await Promise.all([
		db
			.select({
				operator: operatorDailyStats.operator,
				total: sum(operatorDailyStats.total).as("total"),
				cancelled: sum(operatorDailyStats.cancelled).as("cancelled"),
				ghost: sum(operatorDailyStats.ghost).as("ghost"),
				delayed: sum(operatorDailyStats.delayed).as("delayed"),
				avgDelay: sql<
					number | null
				>`SUM(${operatorDailyStats.avgDelay} * ${operatorDailyStats.total}) / NULLIF(SUM(CASE WHEN ${operatorDailyStats.avgDelay} IS NOT NULL THEN ${operatorDailyStats.total} END), 0)`.as(
					"avg_delay",
				),
			})
			.from(operatorDailyStats)
			.where(opDaysCond)
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
					gte(journeyRuns.dayOfOperation, sql`date('now', '-30 days')`),
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
		avgDelay: r.avgDelay,
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
	db: Db,
	filter: QueryFilter = {},
): Promise<LineSummary[]> {
	const daysCond = daysCondition(lineDailyStats.date, filter.days);
	const rows = await db
		.select({
			line: lineDailyStats.line,
			category: lineDailyStats.category,
			operators:
				sql<string>`GROUP_CONCAT(DISTINCT ${lineDailyStats.operators})`.as(
					"operators",
				),
			destinations:
				sql<string>`GROUP_CONCAT(DISTINCT ${lineDailyStats.destinations})`.as(
					"destinations",
				),
			total: sum(lineDailyStats.total).as("total"),
			cancelled: sum(lineDailyStats.cancelled).as("cancelled"),
			ghost: sum(lineDailyStats.ghost).as("ghost"),
			delayed: sum(lineDailyStats.delayed).as("delayed"),
			avgDelay: sql<
				number | null
			>`SUM(${lineDailyStats.avgDelay} * ${lineDailyStats.total}) / NULLIF(SUM(CASE WHEN ${lineDailyStats.avgDelay} IS NOT NULL THEN ${lineDailyStats.total} END), 0)`.as(
				"avg_delay",
			),
		})
		.from(lineDailyStats)
		.where(daysCond)
		.groupBy(lineDailyStats.line, lineDailyStats.category)
		.orderBy(lineDailyStats.category, lineDailyStats.line);

	return rows.map((r) => ({
		line: r.line,
		category: r.category ?? "Bus",
		operators: r.operators ? r.operators.split(",") : [],
		destinations: r.destinations ? r.destinations.split(",") : [],
		total: Number(r.total ?? 0),
		cancelled: Number(r.cancelled ?? 0),
		ghost: Number(r.ghost ?? 0),
		delayed: Number(r.delayed ?? 0),
		avgDelay: r.avgDelay,
	}));
}

export interface LineDayStats {
	date: string;
	total: number;
	cancelled: number;
	ghost: number;
	delayed: number;
	avgDelay: number | null;
}

export async function getLineStats(
	db: Db,
	line: string,
	filter: QueryFilter = {},
): Promise<{
	days: LineDayStats[];
	operators: string[];
	categories: string[];
}> {
	const daysCond = daysCondition(lineDailyStats.date, filter.days);
	const conditions = [eq(lineDailyStats.line, line)];
	if (daysCond) conditions.push(daysCond);

	const rows = await db
		.select()
		.from(lineDailyStats)
		.where(and(...conditions))
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
			avgDelay: d.avgDelay,
		})),
		operators: [...operators],
		categories: [...categories],
	};
}

type OperatorDayStats = InferSelectModel<typeof operatorDailyStats>;

export async function getOperatorStats(
	db: Db,
	operator: string,
	filter: QueryFilter = {},
): Promise<{
	days: OperatorDayStats[];
	lines: string[];
	categories: string[];
}> {
	const opDaysCond = daysCondition(operatorDailyStats.date, filter.days);

	const [dayRows, lineRows, catRows] = await Promise.all([
		db
			.select()
			.from(operatorDailyStats)
			.where(and(eq(operatorDailyStats.operator, operator), opDaysCond))
			.orderBy(desc(operatorDailyStats.date)),
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
		days: dayRows,
		lines: lineRows.map((r) => r.line),
		categories: catRows.map((r) => r.category).filter(Boolean) as string[],
	};
}

export async function getOldestDate(
	db: Db,
	entity?: {
		stopIds?: string[];
		line?: string;
		operator?: string;
	},
): Promise<string | null> {
	if (entity?.stopIds) {
		const stopIdList = sqlIdList(entity.stopIds);
		const rows = await db
			.select({
				date: sql<string>`MIN(${journeyStops.dayOfOperation})`,
			})
			.from(journeyStops)
			.where(sql`${journeyStops.stopId} IN (${stopIdList})`);
		return rows[0]?.date ?? null;
	}
	if (entity?.line) {
		const rows = await db
			.select({ date: sql<string>`MIN(${lineDailyStats.date})` })
			.from(lineDailyStats)
			.where(eq(lineDailyStats.line, entity.line));
		return rows[0]?.date ?? null;
	}
	if (entity?.operator) {
		const rows = await db
			.select({
				date: sql<string>`MIN(${operatorDailyStats.date})`,
			})
			.from(operatorDailyStats)
			.where(eq(operatorDailyStats.operator, entity.operator));
		return rows[0]?.date ?? null;
	}
	const rows = await db
		.select({
			date: sql<string>`MIN(${journeyStops.dayOfOperation})`,
		})
		.from(journeyStops);
	return rows[0]?.date ?? null;
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

export async function getStopSummaries(
	db: Db,
	filter: QueryFilter = {},
): Promise<StopSummary[]> {
	const daysCond = daysCondition(journeyStops.dayOfOperation, filter.days);
	if (!daysCond) {
		const rows = await db
			.select({
				stopIds: sql<string>`GROUP_CONCAT(DISTINCT ${knownStops.stopId})`.as(
					"stop_ids",
				),
				stopName: knownStops.stopName,
				journeyCount: sql<number>`SUM(${knownStops.journeyCount})`.as(
					"journey_count",
				),
				cancelled: sql<number>`SUM(${knownStops.cancelled})`.as("cancelled"),
				ghost: sql<number>`SUM(${knownStops.ghost})`.as("ghost"),
				delayed: sql<number>`SUM(${knownStops.delayed})`.as("delayed"),
				lines: sql<string>`GROUP_CONCAT(DISTINCT ${knownStops.lines})`.as(
					"lines",
				),
				categories:
					sql<string>`GROUP_CONCAT(DISTINCT ${knownStops.categories})`.as(
						"categories",
					),
			})
			.from(knownStops)
			.groupBy(knownStops.stopName)
			.orderBy(sql`journey_count DESC`);

		return rows.map((r) => ({
			stopIds: r.stopIds ? r.stopIds.split(",") : [],
			stopName: r.stopName,
			journeyCount: r.journeyCount,
			cancelled: r.cancelled,
			ghost: r.ghost,
			delayed: r.delayed,
			lines: r.lines ? [...new Set(r.lines.split(","))].filter(Boolean) : [],
			categories: r.categories
				? [...new Set(r.categories.split(","))].filter(Boolean)
				: [],
		}));
	}

	const rows = await db
		.select({
			stopIds: sql<string>`GROUP_CONCAT(DISTINCT ${knownStops.stopId})`.as(
				"stop_ids",
			),
			stopName: knownStops.stopName,
			lines: sql<string>`GROUP_CONCAT(DISTINCT ${knownStops.lines})`.as(
				"lines",
			),
			categories:
				sql<string>`GROUP_CONCAT(DISTINCT ${knownStops.categories})`.as(
					"categories",
				),
			journeyCount:
				sql<number>`COALESCE(COUNT(${journeyRuns.journeyRef}), 0)`.as(
					"journey_count",
				),
			cancelled:
				sql<number>`COALESCE(SUM(CASE WHEN ${journeyRuns.journeyRef} IS NOT NULL THEN ${journeyStops.cancelled} ELSE 0 END), 0)`.as(
					"cancelled",
				),
			ghost: sql<number>`COALESCE(SUM(${ghostCaseSql}), 0)`.as("ghost"),
			delayed:
				sql<number>`COALESCE(SUM(CASE WHEN ${journeyRuns.journeyRef} IS NOT NULL AND ${journeyStops.cancelled} = 0 AND ${journeyStops.rtDepTime} IS NOT NULL AND ${journeyStops.depTime} IS NOT NULL AND (strftime('%s', ${journeyStops.dayOfOperation} || 'T' || ${journeyStops.rtDepTime}) - strftime('%s', ${journeyStops.dayOfOperation} || 'T' || ${journeyStops.depTime})) / 60.0 >= ${DELAY_THRESHOLD_MIN} THEN 1 ELSE 0 END), 0)`.as(
					"delayed",
				),
		})
		.from(knownStops)
		.leftJoin(
			journeyStops,
			and(eq(journeyStops.stopId, knownStops.stopId), daysCond),
		)
		.leftJoin(
			journeyRuns,
			and(
				eq(journeyRuns.journeyRef, journeyStops.journeyRef),
				eq(journeyRuns.dayOfOperation, journeyStops.dayOfOperation),
			),
		)
		.groupBy(knownStops.stopName)
		.orderBy(sql`journey_count DESC`);

	return rows.map((r) => ({
		stopIds: r.stopIds ? r.stopIds.split(",") : [],
		stopName: r.stopName,
		journeyCount: Number(r.journeyCount ?? 0),
		cancelled: Number(r.cancelled ?? 0),
		ghost: Number(r.ghost ?? 0),
		delayed: Number(r.delayed ?? 0),
		lines: r.lines ? [...new Set(r.lines.split(","))].filter(Boolean) : [],
		categories: r.categories
			? [...new Set(r.categories.split(","))].filter(Boolean)
			: [],
	}));
}

export interface KnownStop {
	stopIds: string[];
	stopName: string;
	categories: string[];
}

export async function findStopBySlug(
	db: Db,
	slug: string,
): Promise<KnownStop | null> {
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

export async function getStopStats(
	db: Db,
	stopIds: string[],
	filter: QueryFilter = {},
): Promise<Stats> {
	const stopIdList = sqlIdList(stopIds);
	const daysCond = daysCondition(journeyStops.dayOfOperation, filter.days);
	const conditions = [sql`${journeyStops.stopId} IN (${stopIdList})`];
	if (daysCond) conditions.push(daysCond);

	const [dayRows, haikuRows, metaRows] = await Promise.all([
		db
			.select({
				date: journeyStops.dayOfOperation,
				total: count().as("total"),
				cancelled: sql<number>`SUM(${journeyStops.cancelled})`.as("cancelled"),
				ghost: sql<number>`SUM(${ghostCaseSql})`.as("ghost"),
				delayed:
					sql<number>`SUM(CASE WHEN ${journeyStops.cancelled} = 0 AND ${journeyStops.rtDepTime} IS NOT NULL AND ${journeyStops.depTime} IS NOT NULL AND (strftime('%s', ${journeyStops.dayOfOperation} || 'T' || ${journeyStops.rtDepTime}) - strftime('%s', ${journeyStops.dayOfOperation} || 'T' || ${journeyStops.depTime})) / 60.0 >= ${DELAY_THRESHOLD_MIN} THEN 1 ELSE 0 END)`.as(
						"delayed",
					),
				avgDelay: sql<
					number | null
				>`AVG(CASE WHEN ${journeyStops.cancelled} = 1 THEN ${PLANNED_FREQUENCY_MIN} WHEN ${journeyStops.rtDepTime} IS NOT NULL AND ${journeyStops.depTime} IS NOT NULL THEN (strftime('%s', ${journeyStops.dayOfOperation} || 'T' || ${journeyStops.rtDepTime}) - strftime('%s', ${journeyStops.dayOfOperation} || 'T' || ${journeyStops.depTime})) / 60.0 END)`.as(
					"avg_delay",
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
			.where(and(...conditions))
			.groupBy(journeyStops.dayOfOperation)
			.orderBy(desc(journeyStops.dayOfOperation)),
		db
			.select({ haiku: haikus.haiku, haikuDe: haikus.haikuDe })
			.from(haikus)
			.where(eq(haikus.date, todayBerlin()))
			.limit(1),
		db
			.select({
				lastChange: sql<string | null>`MAX(${journeyRuns.snapshotAt})`.as(
					"last_change",
				),
				categories:
					sql<string>`GROUP_CONCAT(DISTINCT ${journeyRuns.category})`.as(
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
			.where(and(...conditions)),
	]);

	const meta = metaRows[0];
	return {
		days: dayRows.map((d) => ({
			date: d.date,
			total: d.total,
			cancelled: d.cancelled,
			ghost: d.ghost,
			delayed: d.delayed,
			avgDelay: d.avgDelay,
		})),
		lastChange: meta?.lastChange ?? null,
		haiku: haikuRows[0]?.haiku ?? null,
		categories: meta?.categories
			? [...new Set(meta.categories.split(","))].filter(Boolean)
			: [],
	};
}

export async function getStopDayDepartures(
	db: Db,
	stopIds: string[],
	date: string,
) {
	const stopIdList = sqlIdList(stopIds);
	return db
		.select({
			date: journeyStops.dayOfOperation,
			time: sql<string>`COALESCE(${journeyStops.depTime}, ${journeyStops.arrTime})`.as(
				"time",
			),
			rtDate: journeyStops.dayOfOperation,
			rtTime: sql<
				string | null
			>`COALESCE(${journeyStops.rtDepTime}, ${journeyStops.rtArrTime})`.as(
				"rt_time",
			),
			line: journeyRuns.line,
			direction: journeyRuns.destName,
			cancelled: journeyStops.cancelled,
			ghost: ghostCaseSql.as("ghost"),
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
				sql`${journeyStops.stopId} IN (${stopIdList})`,
				eq(journeyStops.dayOfOperation, date),
			),
		)
		.orderBy(sql`time`, journeyRuns.line);
}

export async function getLineDayJourneys(db: Db, line: string, date: string) {
	return db
		.select({
			date: journeyRuns.dayOfOperation,
			time: journeyRuns.originDepTime,
			rtDate: journeyRuns.dayOfOperation,
			rtTime: sql<
				string | null
			>`(SELECT js.rt_dep_time FROM journey_stops js WHERE js.journey_ref = "journey_runs"."journey_ref" AND js.day_of_operation = "journey_runs"."day_of_operation" AND js.route_idx = 0)`.as(
				"rt_time",
			),
			direction: journeyRuns.destName,
			cancelled: journeyRuns.cancelled,
			ghost: ghostCaseSql.as("ghost"),
			operator: journeyRuns.operator,
			category: journeyRuns.category,
			stop: journeyRuns.originName,
		})
		.from(journeyRuns)
		.where(
			and(eq(journeyRuns.line, line), eq(journeyRuns.dayOfOperation, date)),
		)
		.orderBy(journeyRuns.originDepTime, journeyRuns.destName);
}

export async function getOperatorDayJourneys(
	db: Db,
	operator: string,
	date: string,
) {
	return db
		.select({
			date: journeyRuns.dayOfOperation,
			time: journeyRuns.originDepTime,
			rtDate: journeyRuns.dayOfOperation,
			rtTime: sql<
				string | null
			>`(SELECT js.rt_dep_time FROM journey_stops js WHERE js.journey_ref = "journey_runs"."journey_ref" AND js.day_of_operation = "journey_runs"."day_of_operation" AND js.route_idx = 0)`.as(
				"rt_time",
			),
			line: journeyRuns.line,
			category: journeyRuns.category,
			direction: journeyRuns.destName,
			cancelled: journeyRuns.cancelled,
			ghost: ghostCaseSql.as("ghost"),
			stop: journeyRuns.originName,
		})
		.from(journeyRuns)
		.where(
			and(
				eq(journeyRuns.operator, operator),
				eq(journeyRuns.dayOfOperation, date),
			),
		)
		.orderBy(journeyRuns.originDepTime, journeyRuns.line, journeyRuns.destName);
}

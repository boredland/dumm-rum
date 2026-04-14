import type { InferSelectModel } from "drizzle-orm";
import { and, count, desc, eq, gte, isNotNull, sql, sum } from "drizzle-orm";
import type { Db } from "../db/client";
import {
	departures,
	haikus,
	journeyRuns,
	journeyStops,
	knownStops,
	lineDailyStats,
	operatorDailyStats,
	stationDailyStats,
} from "../db/schema";
import type { Station } from "./stations";
import {
	DELAY_THRESHOLD_MIN,
	PLANNED_FREQUENCY_MIN,
	todayBerlin,
} from "./utils";

const CORE_HOURS = sql`((${departures.time} >= '06:00:00' AND ${departures.time} < '09:00:00') OR (${departures.time} >= '16:00:00' AND ${departures.time} < '19:00:00'))`;

export type DaysFilter = "" | "all" | "today" | "weekdays" | "weekends";

function daysCondition(dateCol: unknown, filter: DaysFilter = "") {
	if (filter === "today")
		return eq(dateCol as typeof departures.date, todayBerlin());
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

const validCategories = new Set(["U-Bahn", "S", "Tram", "Bus", "RE,RB"]);

export function parseFilter(url: URL): QueryFilter {
	const days = url.searchParams.get("days") ?? "today";
	const cat = url.searchParams.get("cat") ?? "";
	return {
		coreOnly: url.searchParams.get("hours") === "core",
		days: validDays.has(days as DaysFilter) ? (days as DaysFilter) : "today",
		category: validCategories.has(cat) ? cat : "",
	};
}

export type DayStats = InferSelectModel<typeof stationDailyStats>;

export interface QueryFilter {
	coreOnly?: boolean;
	days?: DaysFilter;
	category?: string;
}

function categoryCondition(category?: string) {
	if (!category) return undefined;
	const cats = category.split(",");
	if (cats.length === 1) return eq(departures.category, cats[0]);
	return sql`${departures.category} IN (${sql.join(
		cats.map((c) => sql`${c}`),
		sql`, `,
	)})`;
}

export interface Stats {
	days: DayStats[];
	lastChange: string | null;
	haiku: string | null;
	categories: string[];
}

export async function getStats(
	db: Db,
	station: Station,
	filter: QueryFilter = {},
): Promise<Stats> {
	if (filter.coreOnly) {
		return getStatsFallback(db, station, filter);
	}

	const daysCond = daysCondition(stationDailyStats.date, filter.days);
	const conditions = [eq(stationDailyStats.stationId, station.id)];
	if (daysCond) conditions.push(daysCond);

	const [dayRows, lastChangeRows, haikuRows, catRows] = await Promise.all([
		db
			.select()
			.from(stationDailyStats)
			.where(and(...conditions))
			.orderBy(desc(stationDailyStats.date)),
		db
			.select({ fetchedAt: departures.fetchedAt })
			.from(departures)
			.where(eq(departures.stationId, station.id))
			.orderBy(desc(departures.fetchedAt))
			.limit(1),
		db
			.select({ haiku: haikus.haiku })
			.from(haikus)
			.where(eq(haikus.date, todayBerlin()))
			.limit(1),
		db
			.selectDistinct({ category: departures.category })
			.from(departures)
			.where(
				and(
					eq(departures.stationId, station.id),
					isNotNull(departures.category),
				),
			),
	]);

	return {
		days: dayRows,
		lastChange: lastChangeRows[0]?.fetchedAt ?? null,
		haiku: haikuRows[0]?.haiku ?? null,
		categories: catRows.map((r) => r.category!),
	};
}

export const avgDelaySql = sql<
	number | null
>`AVG(CASE WHEN ${departures.cancelled} = 1 THEN ${PLANNED_FREQUENCY_MIN} WHEN ${departures.rtTime} IS NOT NULL THEN MIN((strftime('%s', ${departures.rtDate} || ' ' || ${departures.rtTime}) - strftime('%s', ${departures.date} || ' ' || ${departures.time})) / 60.0, ${PLANNED_FREQUENCY_MIN}) END)`;

export const delayedSql = sql<number>`SUM(CASE WHEN ${departures.cancelled} = 0 AND ${departures.rtTime} IS NOT NULL AND (strftime('%s', ${departures.rtDate} || ' ' || ${departures.rtTime}) - strftime('%s', ${departures.date} || ' ' || ${departures.time})) / 60.0 >= ${DELAY_THRESHOLD_MIN} THEN 1 ELSE 0 END)`;

export const ghostSql = sql<number>`SUM(${departures.ghost})`;

export const totalDistinctSql = sql<number>`COUNT(DISTINCT ${departures.journeyNum})`;
export const cancelledDistinctSql = sql<number>`COUNT(DISTINCT CASE WHEN ${departures.cancelled} = 1 THEN ${departures.journeyNum} END)`;
export const ghostDistinctSql = sql<number>`COUNT(DISTINCT CASE WHEN ${departures.ghost} = 1 THEN ${departures.journeyNum} END)`;
export const delayedDistinctSql = sql<number>`COUNT(DISTINCT CASE WHEN ${departures.cancelled} = 0 AND ${departures.rtTime} IS NOT NULL AND (strftime('%s', ${departures.rtDate} || ' ' || ${departures.rtTime}) - strftime('%s', ${departures.date} || ' ' || ${departures.time})) / 60.0 >= ${DELAY_THRESHOLD_MIN} THEN ${departures.journeyNum} END)`;

async function getStatsFallback(
	db: Db,
	station: Station,
	filter: QueryFilter = {},
): Promise<Stats> {
	const daysCond = daysCondition(departures.date, filter.days);
	const conditions = [eq(departures.stationId, station.id), CORE_HOURS];
	if (daysCond) conditions.push(daysCond);

	const [dayRows, lastChangeRows, haikuRows, catRows] = await Promise.all([
		db
			.select({
				stationId: departures.stationId,
				date: departures.date,
				total: count().as("total"),
				cancelled: sql<number>`SUM(${departures.cancelled})`.as("cancelled"),
				ghost: ghostSql.as("ghost"),
				delayed: delayedSql.as("delayed"),
				avgDelay: avgDelaySql.as("avg_delay"),
			})
			.from(departures)
			.where(and(...conditions))
			.groupBy(departures.date)
			.orderBy(desc(departures.date)),
		db
			.select({ fetchedAt: departures.fetchedAt })
			.from(departures)
			.where(eq(departures.stationId, station.id))
			.orderBy(desc(departures.fetchedAt))
			.limit(1),
		db
			.select({ haiku: haikus.haiku })
			.from(haikus)
			.where(eq(haikus.date, todayBerlin()))
			.limit(1),
		db
			.selectDistinct({ category: departures.category })
			.from(departures)
			.where(
				and(
					eq(departures.stationId, station.id),
					isNotNull(departures.category),
				),
			),
	]);

	return {
		days: dayRows,
		lastChange: lastChangeRows[0]?.fetchedAt ?? null,
		haiku: haikuRows[0]?.haiku ?? null,
		categories: catRows.map((r) => r.category!),
	};
}

export async function getDayDepartures(db: Db, station: Station, date: string) {
	return db
		.select({
			date: departures.date,
			time: departures.time,
			rtDate: departures.rtDate,
			rtTime: departures.rtTime,
			line: departures.line,
			direction: departures.direction,
			cancelled: departures.cancelled,
			ghost: departures.ghost,
		})
		.from(departures)
		.where(and(eq(departures.stationId, station.id), eq(departures.date, date)))
		.orderBy(departures.time, departures.direction);
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
	const depDaysCond = daysCondition(departures.date, filter.days);
	const opDaysCond = daysCondition(operatorDailyStats.date, filter.days);
	const catCond = categoryCondition(filter.category);
	const useDepartures = filter.coreOnly || !!catCond;

	const [statsRows, lineRows] = await Promise.all([
		useDepartures
			? db
					.select({
						operator: departures.operator,
						total: totalDistinctSql.as("total"),
						cancelled: cancelledDistinctSql.as("cancelled"),
						ghost: ghostDistinctSql.as("ghost"),
						delayed: delayedDistinctSql.as("delayed"),
						avgDelay: avgDelaySql.as("avg_delay"),
					})
					.from(departures)
					.where(
						and(
							isNotNull(departures.operator),
							filter.coreOnly ? CORE_HOURS : undefined,
							depDaysCond,
							catCond,
						),
					)
					.groupBy(departures.operator)
			: db
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
				operator: departures.operator,
				line: departures.line,
				category: departures.category,
			})
			.from(departures)
			.where(
				and(
					isNotNull(departures.operator),
					gte(departures.date, sql`date('now', '-30 days')`),
				),
			)
			.orderBy(departures.operator, departures.line),
	]);

	const lineMap = new Map<string, string[]>();
	const catMap = new Map<string, Set<string>>();
	for (const row of lineRows) {
		const lines = lineMap.get(row.operator!) ?? [];
		lines.push(row.line);
		lineMap.set(row.operator!, lines);
		if (row.category) {
			const cats = catMap.get(row.operator!) ?? new Set();
			cats.add(row.category);
			catMap.set(row.operator!, cats);
		}
	}

	return statsRows.map((r) => ({
		operator: r.operator!,
		lines: lineMap.get(r.operator!) ?? [],
		categories: [...(catMap.get(r.operator!) ?? [])],
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
	const catCond = categoryCondition(filter.category);
	const useDepartures = filter.coreOnly || !!catCond;

	if (useDepartures) {
		const daysCond = daysCondition(departures.date, filter.days);
		const conditions = [isNotNull(departures.operator)];
		if (filter.coreOnly) conditions.push(CORE_HOURS);
		if (daysCond) conditions.push(daysCond);
		if (catCond) conditions.push(catCond);

		const rows = await db
			.select({
				line: departures.line,
				category: departures.category,
				operators:
					sql<string>`GROUP_CONCAT(DISTINCT ${departures.operator})`.as(
						"operators",
					),
				destinations:
					sql<string>`GROUP_CONCAT(DISTINCT ${departures.direction})`.as(
						"destinations",
					),
				total: totalDistinctSql.as("total"),
				cancelled: cancelledDistinctSql.as("cancelled"),
				ghost: ghostDistinctSql.as("ghost"),
				delayed: delayedDistinctSql.as("delayed"),
				avgDelay: avgDelaySql.as("avg_delay"),
			})
			.from(departures)
			.where(and(...conditions))
			.groupBy(departures.line, departures.category)
			.orderBy(departures.category, departures.line);

		return rows.map((r) => ({
			line: r.line,
			category: r.category ?? "Bus",
			operators: r.operators ? r.operators.split(",") : [],
			destinations: r.destinations ? r.destinations.split(",") : [],
			total: r.total,
			cancelled: r.cancelled,
			ghost: r.ghost,
			delayed: r.delayed,
			avgDelay: r.avgDelay,
		}));
	}

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
	if (filter.coreOnly) {
		const daysCond = daysCondition(departures.date, filter.days);
		const conditions = [eq(departures.line, line)];
		conditions.push(CORE_HOURS);
		if (daysCond) conditions.push(daysCond);

		const [dayRows, opRows, catRows] = await Promise.all([
			db
				.select({
					date: departures.date,
					total: totalDistinctSql.as("total"),
					cancelled: cancelledDistinctSql.as("cancelled"),
					ghost: ghostDistinctSql.as("ghost"),
					delayed: delayedDistinctSql.as("delayed"),
					avgDelay: avgDelaySql.as("avg_delay"),
				})
				.from(departures)
				.where(and(...conditions))
				.groupBy(departures.date)
				.orderBy(desc(departures.date)),
			db
				.selectDistinct({ operator: departures.operator })
				.from(departures)
				.where(and(eq(departures.line, line), isNotNull(departures.operator))),
			db
				.selectDistinct({ category: departures.category })
				.from(departures)
				.where(and(eq(departures.line, line), isNotNull(departures.category))),
		]);

		return {
			days: dayRows.map((d) => ({
				date: d.date,
				total: d.total,
				cancelled: d.cancelled,
				ghost: d.ghost,
				delayed: d.delayed,
				avgDelay: d.avgDelay,
			})),
			operators: opRows.map((r) => r.operator!),
			categories: catRows.map((r) => r.category!),
		};
	}

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

export async function getLineDayDepartures(db: Db, line: string, date: string) {
	return db
		.select({
			date: departures.date,
			time: sql<string>`min(${departures.time})`.as("time"),
			rtDate: departures.rtDate,
			rtTime: departures.rtTime,
			direction: departures.direction,
			cancelled: sql<number>`max(${departures.cancelled})`.as("cancelled"),
			ghost: sql<number>`max(${departures.ghost})`.as("ghost"),
			operator: departures.operator,
			category: departures.category,
			stop: departures.stop,
		})
		.from(departures)
		.where(and(eq(departures.line, line), eq(departures.date, date)))
		.groupBy(
			departures.date,
			departures.line,
			departures.direction,
			departures.journeyNum,
		)
		.orderBy(sql`time`, departures.direction);
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
	const depDaysCond = daysCondition(departures.date, filter.days);
	const opDaysCond = daysCondition(operatorDailyStats.date, filter.days);

	const [dayRows, lineRows, catRows] = await Promise.all([
		filter.coreOnly
			? db
					.select({
						operator: departures.operator,
						date: departures.date,
						total: totalDistinctSql.as("total"),
						cancelled: cancelledDistinctSql.as("cancelled"),
						ghost: ghostDistinctSql.as("ghost"),
						delayed: delayedDistinctSql.as("delayed"),
						avgDelay: avgDelaySql.as("avg_delay"),
					})
					.from(departures)
					.where(
						and(eq(departures.operator, operator), CORE_HOURS, depDaysCond),
					)
					.groupBy(departures.date)
					.orderBy(desc(departures.date))
			: db
					.select()
					.from(operatorDailyStats)
					.where(and(eq(operatorDailyStats.operator, operator), opDaysCond))
					.orderBy(desc(operatorDailyStats.date)),
		db
			.selectDistinct({ line: departures.line })
			.from(departures)
			.where(eq(departures.operator, operator))
			.orderBy(departures.line),
		db
			.selectDistinct({ category: departures.category })
			.from(departures)
			.where(
				and(eq(departures.operator, operator), isNotNull(departures.category)),
			),
	]);

	const days = dayRows.map((d) => ({
		operator: d.operator!,
		date: d.date,
		total: Number(d.total),
		cancelled: Number(d.cancelled),
		ghost: Number(d.ghost ?? 0),
		delayed: Number(d.delayed),
		avgDelay: d.avgDelay,
	}));
	return {
		days,
		lines: lineRows.map((r) => r.line),
		categories: catRows.map((r) => r.category!),
	};
}

export async function getOperatorDayDepartures(
	db: Db,
	operator: string,
	date: string,
) {
	return db
		.select({
			date: departures.date,
			time: sql<string>`min(${departures.time})`.as("time"),
			rtDate: departures.rtDate,
			rtTime: departures.rtTime,
			line: departures.line,
			category: departures.category,
			direction: departures.direction,
			cancelled: sql<number>`max(${departures.cancelled})`.as("cancelled"),
			ghost: sql<number>`max(${departures.ghost})`.as("ghost"),
			stop: departures.stop,
		})
		.from(departures)
		.where(and(eq(departures.operator, operator), eq(departures.date, date)))
		.groupBy(
			departures.date,
			departures.line,
			departures.direction,
			departures.journeyNum,
		)
		.orderBy(sql`time`, departures.line, departures.direction);
}

export async function getOldestDate(
	db: Db,
	entity?: {
		station?: string;
		stopIds?: string[];
		line?: string;
		operator?: string;
	},
): Promise<string | null> {
	if (entity?.stopIds) {
		const stopIdList = sql.join(
			entity.stopIds.map((id) => sql`${id}`),
			sql`, `,
		);
		const rows = await db
			.select({
				date: sql<string>`MIN(${journeyStops.dayOfOperation})`,
			})
			.from(journeyStops)
			.where(sql`${journeyStops.stopId} IN (${stopIdList})`);
		return rows[0]?.date ?? null;
	}
	if (entity?.station) {
		const rows = await db
			.select({ date: sql<string>`MIN(${stationDailyStats.date})` })
			.from(stationDailyStats)
			.where(eq(stationDailyStats.stationId, entity.station));
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
			.select({ date: sql<string>`MIN(${departures.date})` })
			.from(departures)
			.where(eq(departures.operator, entity.operator));
		return rows[0]?.date ?? null;
	}
	const rows = await db
		.select({ date: sql<string>`MIN(${stationDailyStats.date})` })
		.from(stationDailyStats);
	return rows[0]?.date ?? null;
}

export interface StopSummary {
	stopIds: string[];
	stopName: string;
	journeyCount: number;
	cancelled: number;
	lines: string[];
	categories: string[];
}

export async function getStopSummaries(db: Db): Promise<StopSummary[]> {
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
	nameToSlug: (name: string) => string,
): Promise<KnownStop | null> {
	const rows = await db.select().from(knownStops);
	const grouped = new Map<
		string,
		{ ids: string[]; name: string; categories: Set<string> }
	>();
	for (const r of rows) {
		const existing = grouped.get(r.stopName);
		if (existing) {
			existing.ids.push(r.stopId);
			if (r.categories)
				for (const c of r.categories.split(",")) existing.categories.add(c);
		} else {
			grouped.set(r.stopName, {
				ids: [r.stopId],
				name: r.stopName,
				categories: new Set(r.categories?.split(",").filter(Boolean) ?? []),
			});
		}
	}
	for (const g of grouped.values()) {
		if (nameToSlug(g.name) === slug) {
			return {
				stopIds: g.ids,
				stopName: g.name,
				categories: [...g.categories],
			};
		}
	}
	return null;
}

export async function getStopStats(
	db: Db,
	stopIds: string[],
	filter: QueryFilter = {},
): Promise<Stats> {
	const stopIdList = sql.join(
		stopIds.map((id) => sql`${id}`),
		sql`, `,
	);
	const daysCond = daysCondition(journeyStops.dayOfOperation, filter.days);
	const conditions = [sql`${journeyStops.stopId} IN (${stopIdList})`];
	if (daysCond) conditions.push(daysCond);

	const [dayRows, haikuRows] = await Promise.all([
		db
			.select({
				date: journeyStops.dayOfOperation,
				total: count().as("total"),
				cancelled: sql<number>`SUM(${journeyStops.cancelled})`.as("cancelled"),
				ghost:
					sql<number>`SUM(CASE WHEN ${journeyRuns.wasTracked} = 0 AND ${journeyRuns.cancelled} = 0 THEN 1 ELSE 0 END)`.as(
						"ghost",
					),
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
			.leftJoin(
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
	]);

	return {
		days: dayRows.map((d) => ({
			stationId: stopIds[0],
			date: d.date,
			total: d.total,
			cancelled: d.cancelled,
			ghost: d.ghost,
			delayed: d.delayed,
			avgDelay: d.avgDelay,
		})),
		lastChange: null,
		haiku: haikuRows[0]?.haiku ?? null,
		categories: [],
	};
}

export async function getStopDayDepartures(
	db: Db,
	stopIds: string[],
	date: string,
) {
	const stopIdList = sql.join(
		stopIds.map((id) => sql`${id}`),
		sql`, `,
	);
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
			ghost:
				sql<number>`CASE WHEN ${journeyRuns.wasTracked} = 0 AND ${journeyRuns.cancelled} = 0 THEN 1 ELSE 0 END`.as(
					"ghost",
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
		.where(
			and(
				sql`${journeyStops.stopId} IN (${stopIdList})`,
				eq(journeyStops.dayOfOperation, date),
			),
		)
		.orderBy(sql`time`, journeyRuns.line);
}

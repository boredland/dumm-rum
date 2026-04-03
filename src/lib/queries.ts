import type { InferSelectModel } from "drizzle-orm";
import { and, count, desc, eq, gte, isNotNull, sql, sum } from "drizzle-orm";
import type { Db } from "../db/client";
import {
	departures,
	haikus,
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
	avgCancelledPerDay: number;
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

	const totalCancelled = dayRows.reduce((s, d) => s + d.cancelled, 0);

	return {
		days: dayRows,
		avgCancelledPerDay:
			dayRows.length > 0 ? totalCancelled / dayRows.length : 0,
		lastChange: lastChangeRows[0]?.fetchedAt ?? null,
		haiku: haikuRows[0]?.haiku ?? null,
		categories: catRows.map((r) => r.category!),
	};
}

export const avgDelaySql = sql<
	number | null
>`AVG(CASE WHEN ${departures.cancelled} = 1 THEN ${PLANNED_FREQUENCY_MIN} WHEN ${departures.rtTime} IS NOT NULL THEN MIN((strftime('%s', ${departures.rtDate} || ' ' || ${departures.rtTime}) - strftime('%s', ${departures.date} || ' ' || ${departures.time})) / 60.0, ${PLANNED_FREQUENCY_MIN}) END)`;

export const delayedSql = sql<number>`SUM(CASE WHEN ${departures.cancelled} = 0 AND ${departures.rtTime} IS NOT NULL AND (strftime('%s', ${departures.rtDate} || ' ' || ${departures.rtTime}) - strftime('%s', ${departures.date} || ' ' || ${departures.time})) / 60.0 >= ${DELAY_THRESHOLD_MIN} THEN 1 ELSE 0 END)`;

export const totalDistinctSql = sql<number>`COUNT(DISTINCT ${departures.journeyNum})`;
export const cancelledDistinctSql = sql<number>`COUNT(DISTINCT CASE WHEN ${departures.cancelled} = 1 THEN ${departures.journeyNum} END)`;
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

	const totalCancelled = dayRows.reduce((s, d) => s + d.cancelled, 0);

	return {
		days: dayRows,
		avgCancelledPerDay:
			dayRows.length > 0 ? totalCancelled / dayRows.length : 0,
		lastChange: lastChangeRows[0]?.fetchedAt ?? null,
		haiku: haikuRows[0]?.haiku ?? null,
		categories: catRows.map((r) => r.category!),
	};
}

export interface StationSummary {
	cancelled: number;
	delayed: number;
	total: number;
	avgDelay: number | null;
	categories: string[];
}

export async function getStationSummaries(
	db: Db,
	stations: Station[],
	filter: QueryFilter = {},
): Promise<Map<string, StationSummary>> {
	const depDaysCond = daysCondition(departures.date, filter.days);
	const statsDaysCond = daysCondition(stationDailyStats.date, filter.days);
	const catCond = categoryCondition(filter.category);
	const useDepartures = filter.coreOnly || !!catCond;

	const [statsRows, catRows] = await Promise.all([
		useDepartures
			? db
					.select({
						stationId: departures.stationId,
						cancelled: sum(departures.cancelled).as("cancelled"),
						delayed: delayedSql.as("delayed"),
						total: count().as("total"),
						avgDelay: avgDelaySql.as("avg_delay"),
					})
					.from(departures)
					.where(
						and(filter.coreOnly ? CORE_HOURS : undefined, depDaysCond, catCond),
					)
					.groupBy(departures.stationId)
			: db
					.select({
						stationId: stationDailyStats.stationId,
						cancelled: sum(stationDailyStats.cancelled).as("cancelled"),
						delayed: sum(stationDailyStats.delayed).as("delayed"),
						total: sum(stationDailyStats.total).as("total"),
						avgDelay: sql<
							number | null
						>`SUM(${stationDailyStats.avgDelay} * ${stationDailyStats.total}) / NULLIF(SUM(CASE WHEN ${stationDailyStats.avgDelay} IS NOT NULL THEN ${stationDailyStats.total} END), 0)`.as(
							"avg_delay",
						),
					})
					.from(stationDailyStats)
					.where(statsDaysCond)
					.groupBy(stationDailyStats.stationId),
		db
			.selectDistinct({
				stationId: departures.stationId,
				category: departures.category,
			})
			.from(departures)
			.where(isNotNull(departures.category)),
	]);

	const statsMap = new Map(
		statsRows.map((r) => [
			r.stationId,
			{
				cancelled: Number(r.cancelled ?? 0),
				delayed: Number(r.delayed ?? 0),
				total: Number(r.total ?? 0),
				avgDelay: r.avgDelay,
			},
		]),
	);

	const catMap = new Map<string, string[]>();
	for (const row of catRows) {
		const cats = catMap.get(row.stationId) ?? [];
		if (row.category) cats.push(row.category);
		catMap.set(row.stationId, cats);
	}

	return new Map(
		stations.map((s) => [
			s.id,
			{
				cancelled: statsMap.get(s.id)?.cancelled ?? 0,
				delayed: statsMap.get(s.id)?.delayed ?? 0,
				total: statsMap.get(s.id)?.total ?? 0,
				avgDelay: statsMap.get(s.id)?.avgDelay ?? null,
				categories: catMap.get(s.id) ?? [],
			},
		]),
	);
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
			.where(isNotNull(departures.operator))
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
	delayed: number;
	avgDelay: number | null;
}

export async function getLineSummaries(
	db: Db,
	filter: QueryFilter = {},
): Promise<LineSummary[]> {
	const daysCond = daysCondition(departures.date, filter.days);
	const catCond = categoryCondition(filter.category);
	const conditions = [isNotNull(departures.operator)];
	if (filter.coreOnly) conditions.push(CORE_HOURS);
	if (daysCond) conditions.push(daysCond);
	if (catCond) conditions.push(catCond);

	const rows = await db
		.select({
			line: departures.line,
			category: departures.category,
			operators: sql<string>`GROUP_CONCAT(DISTINCT ${departures.operator})`.as(
				"operators",
			),
			destinations:
				sql<string>`GROUP_CONCAT(DISTINCT ${departures.direction})`.as(
					"destinations",
				),
			total: totalDistinctSql.as("total"),
			cancelled: cancelledDistinctSql.as("cancelled"),
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
		delayed: r.delayed,
		avgDelay: r.avgDelay,
	}));
}

export interface LineDayStats {
	date: string;
	total: number;
	cancelled: number;
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
	const daysCond = daysCondition(departures.date, filter.days);
	const conditions = [eq(departures.line, line)];
	if (filter.coreOnly) conditions.push(CORE_HOURS);
	if (daysCond) conditions.push(daysCond);

	const [dayRows, opRows, catRows] = await Promise.all([
		db
			.select({
				date: departures.date,
				total: totalDistinctSql.as("total"),
				cancelled: cancelledDistinctSql.as("cancelled"),
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
			delayed: d.delayed,
			avgDelay: d.avgDelay,
		})),
		operators: opRows.map((r) => r.operator!),
		categories: catRows.map((r) => r.category!),
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

export async function getOldestDate(db: Db): Promise<string | null> {
	const rows = await db
		.select({ date: sql<string>`MIN(${stationDailyStats.date})` })
		.from(stationDailyStats);
	return rows[0]?.date ?? null;
}

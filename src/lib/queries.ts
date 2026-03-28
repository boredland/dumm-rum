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
import { delayMinutes, nowBerlin, todayBerlin } from "./utils";

const CORE_HOURS = sql`((${departures.time} >= '06:00:00' AND ${departures.time} < '09:00:00') OR (${departures.time} >= '16:00:00' AND ${departures.time} < '19:00:00'))`;

export type DaysFilter = "" | "weekdays" | "weekends";

function daysCondition(dateCol: unknown, filter: DaysFilter = "") {
	if (filter === "weekdays")
		return sql`strftime('%w', ${dateCol}) NOT IN ('0', '6')`;
	if (filter === "weekends")
		return sql`strftime('%w', ${dateCol}) IN ('0', '6')`;
	return undefined;
}

const validDays = new Set<DaysFilter>(["", "weekdays", "weekends"]);

export function parseFilter(url: URL): QueryFilter {
	const days = url.searchParams.get("days") ?? "";
	return {
		coreOnly: url.searchParams.get("hours") === "core",
		days: validDays.has(days as DaysFilter) ? (days as DaysFilter) : "",
	};
}

export type DayStats = InferSelectModel<typeof stationDailyStats>;

export interface QueryFilter {
	coreOnly?: boolean;
	days?: DaysFilter;
}

export interface Stats {
	days: DayStats[];
	avgCancelledPerDay: number;
	lastChange: string | null;
	haiku: string | null;
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

	const [dayRows, lastChangeRows, haikuRows] = await Promise.all([
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
	]);

	const totalCancelled = dayRows.reduce((s, d) => s + d.cancelled, 0);

	return {
		days: dayRows,
		avgCancelledPerDay:
			dayRows.length > 0 ? totalCancelled / dayRows.length : 0,
		lastChange: lastChangeRows[0]?.fetchedAt ?? null,
		haiku: haikuRows[0]?.haiku ?? null,
	};
}

export const avgDelaySql = sql<
	number | null
>`AVG(CASE WHEN ${departures.cancelled} = 0 AND ${departures.rtTime} IS NOT NULL THEN (strftime('%s', ${departures.rtDate} || ' ' || ${departures.rtTime}) - strftime('%s', ${departures.date} || ' ' || ${departures.time})) / 60.0 END)`;

export const delayedSql = sql<number>`SUM(CASE WHEN ${departures.cancelled} = 0 AND ${departures.rtTime} IS NOT NULL AND (strftime('%s', ${departures.rtDate} || ' ' || ${departures.rtTime}) - strftime('%s', ${departures.date} || ' ' || ${departures.time})) / 60.0 >= 7.5 THEN 1 ELSE 0 END)`;

async function getStatsFallback(
	db: Db,
	station: Station,
	filter: QueryFilter = {},
): Promise<Stats> {
	const daysCond = daysCondition(departures.date, filter.days);
	const conditions = [eq(departures.stationId, station.id), CORE_HOURS];
	if (daysCond) conditions.push(daysCond);

	const [dayRows, lastChangeRows, haikuRows] = await Promise.all([
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
	]);

	const totalCancelled = dayRows.reduce((s, d) => s + d.cancelled, 0);

	return {
		days: dayRows,
		avgCancelledPerDay:
			dayRows.length > 0 ? totalCancelled / dayRows.length : 0,
		lastChange: lastChangeRows[0]?.fetchedAt ?? null,
		haiku: haikuRows[0]?.haiku ?? null,
	};
}

export interface StationSummary {
	cancelled: number;
	delayed: number;
	total: number;
	categories: string[];
}

export async function getStationSummaries(
	db: Db,
	stations: Station[],
	filter: QueryFilter = {},
): Promise<Map<string, StationSummary>> {
	const depDaysCond = daysCondition(departures.date, filter.days);
	const statsDaysCond = daysCondition(stationDailyStats.date, filter.days);

	const [statsRows, catRows] = await Promise.all([
		filter.coreOnly
			? db
					.select({
						stationId: departures.stationId,
						cancelled: sum(departures.cancelled).as("cancelled"),
						delayed: sql<number>`0`.as("delayed"),
						total: count().as("total"),
					})
					.from(departures)
					.where(and(CORE_HOURS, depDaysCond))
					.groupBy(departures.stationId)
			: db
					.select({
						stationId: stationDailyStats.stationId,
						cancelled: sum(stationDailyStats.cancelled).as("cancelled"),
						delayed: sum(stationDailyStats.delayed).as("delayed"),
						total: sum(stationDailyStats.total).as("total"),
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
			fetchedAt: departures.fetchedAt,
		})
		.from(departures)
		.where(and(eq(departures.stationId, station.id), eq(departures.date, date)))
		.orderBy(departures.time, departures.direction);
}

export type DepartureRow = Awaited<ReturnType<typeof getDayDepartures>>[number];

export async function getStationCategories(
	db: Db,
	station: Station,
): Promise<string[]> {
	const rows = await db
		.selectDistinct({ category: departures.category })
		.from(departures)
		.where(
			and(eq(departures.stationId, station.id), isNotNull(departures.category)),
		);
	return rows.map((r) => r.category!);
}

export async function getHaiku(db: Db, date: string): Promise<string | null> {
	const rows = await db
		.select({ haiku: haikus.haiku })
		.from(haikus)
		.where(eq(haikus.date, date))
		.limit(1);
	return rows[0]?.haiku ?? null;
}

export async function getNextDepartures(db: Db, station: Station) {
	return db
		.select({
			time: sql<string>`MIN(${departures.time})`.as("time"),
			rtTime: departures.rtTime,
			direction: departures.direction,
			line: departures.line,
		})
		.from(departures)
		.where(
			and(
				eq(departures.stationId, station.id),
				eq(departures.date, todayBerlin()),
				eq(departures.cancelled, 0),
				gte(departures.time, nowBerlin().format("HH:mm:ss")),
			),
		)
		.groupBy(departures.direction)
		.orderBy(sql`time`);
}

export interface OperatorSummary {
	operator: string;
	lines: string[];
	total: number;
	cancelled: number;
	avgDelay: number | null;
}

export async function getOperatorSummaries(
	db: Db,
	filter: QueryFilter = {},
): Promise<OperatorSummary[]> {
	const depDaysCond = daysCondition(departures.date, filter.days);
	const opDaysCond = daysCondition(operatorDailyStats.date, filter.days);

	const [statsRows, lineRows] = await Promise.all([
		filter.coreOnly
			? db
					.select({
						operator: departures.operator,
						total: count().as("total"),
						cancelled: sql<number>`SUM(${departures.cancelled})`.as(
							"cancelled",
						),
						avgDelay: avgDelaySql.as("avg_delay"),
					})
					.from(departures)
					.where(and(isNotNull(departures.operator), CORE_HOURS, depDaysCond))
					.groupBy(departures.operator)
			: db
					.select({
						operator: operatorDailyStats.operator,
						total: sum(operatorDailyStats.total).as("total"),
						cancelled: sum(operatorDailyStats.cancelled).as("cancelled"),
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
			})
			.from(departures)
			.where(isNotNull(departures.operator))
			.orderBy(departures.operator, departures.line),
	]);

	const lineMap = new Map<string, string[]>();
	for (const row of lineRows) {
		const lines = lineMap.get(row.operator!) ?? [];
		lines.push(row.line);
		lineMap.set(row.operator!, lines);
	}

	return statsRows.map((r) => ({
		operator: r.operator!,
		lines: lineMap.get(r.operator!) ?? [],
		total: Number(r.total ?? 0),
		cancelled: Number(r.cancelled ?? 0),
		avgDelay: r.avgDelay,
	}));
}

export interface LineSummary {
	line: string;
	category: string;
	total: number;
	cancelled: number;
	delayed: number;
}

export async function getLineSummaries(
	db: Db,
	filter: QueryFilter = {},
): Promise<LineSummary[]> {
	const daysCond = daysCondition(departures.date, filter.days);
	const conditions = [isNotNull(departures.operator)];
	if (filter.coreOnly) conditions.push(CORE_HOURS);
	if (daysCond) conditions.push(daysCond);

	const rows = await db
		.select({
			line: departures.line,
			category: departures.category,
			total: count().as("total"),
			cancelled: sql<number>`SUM(${departures.cancelled})`.as("cancelled"),
			delayed: delayedSql.as("delayed"),
		})
		.from(departures)
		.where(and(...conditions))
		.groupBy(departures.line, departures.category)
		.orderBy(departures.category, departures.line);

	return rows.map((r) => ({
		line: r.line,
		category: r.category ?? "Bus",
		total: r.total,
		cancelled: r.cancelled,
		delayed: r.delayed,
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
): Promise<{ days: LineDayStats[]; operators: string[] }> {
	const daysCond = daysCondition(departures.date, filter.days);
	const conditions = [eq(departures.line, line)];
	if (filter.coreOnly) conditions.push(CORE_HOURS);
	if (daysCond) conditions.push(daysCond);

	const [dayRows, opRows] = await Promise.all([
		db
			.select({
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
			.selectDistinct({ operator: departures.operator })
			.from(departures)
			.where(and(eq(departures.line, line), isNotNull(departures.operator))),
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
	};
}

export async function getLineDayDepartures(db: Db, line: string, date: string) {
	return db
		.select({
			date: departures.date,
			time: departures.time,
			rtDate: departures.rtDate,
			rtTime: departures.rtTime,
			direction: departures.direction,
			cancelled: departures.cancelled,
			operator: departures.operator,
			stop: departures.stop,
			fetchedAt: departures.fetchedAt,
		})
		.from(departures)
		.where(and(eq(departures.line, line), eq(departures.date, date)))
		.orderBy(departures.time, departures.direction);
}

export type OperatorDayStats = InferSelectModel<typeof operatorDailyStats>;

export async function getOperatorStats(
	db: Db,
	operator: string,
	filter: QueryFilter = {},
): Promise<{ days: OperatorDayStats[]; lines: string[] }> {
	const depDaysCond = daysCondition(departures.date, filter.days);
	const opDaysCond = daysCondition(operatorDailyStats.date, filter.days);

	const [dayRows, lineRows] = await Promise.all([
		filter.coreOnly
			? db
					.select({
						operator: departures.operator,
						date: departures.date,
						total: count().as("total"),
						cancelled: sql<number>`SUM(${departures.cancelled})`.as(
							"cancelled",
						),
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
	]);

	const days = dayRows.map((d) => ({
		operator: d.operator!,
		date: d.date,
		total: Number(d.total),
		cancelled: Number(d.cancelled),
		delayed: "delayed" in d ? Number(d.delayed) : 0,
		avgDelay: d.avgDelay,
	}));
	return { days, lines: lineRows.map((r) => r.line) };
}

const DELAY_THRESHOLD_MIN = 7.5;

export function dayAvgDelay(departureRows: DepartureRow[]): number | null {
	let totalDelay = 0;
	let delayCount = 0;
	for (const d of departureRows) {
		if (d.cancelled) {
			totalDelay += DELAY_THRESHOLD_MIN;
			delayCount++;
		} else if (d.rtTime && d.rtDate) {
			totalDelay += delayMinutes(d.date, d.time, d.rtDate, d.rtTime);
			delayCount++;
		}
	}
	return delayCount > 0 ? totalDelay / delayCount : null;
}

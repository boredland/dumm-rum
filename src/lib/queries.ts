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
import { nowBerlin, timeToMinutes, todayBerlin } from "./utils";

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

const avgDelaySql = sql<
	number | null
>`AVG(CASE WHEN ${departures.cancelled} = 0 AND ${departures.rtTime} IS NOT NULL THEN (strftime('%s', ${departures.rtDate} || ' ' || ${departures.rtTime}) - strftime('%s', ${departures.date} || ' ' || ${departures.time})) / 60.0 END)`;
const rtCountSql = sql<number>`SUM(CASE WHEN ${departures.cancelled} = 0 AND ${departures.rtTime} IS NOT NULL THEN 1 ELSE 0 END)`;

interface DirRow {
	date: string;
	direction: string;
	total: number;
	cancelled: number;
	avg_delay: number | null;
	rt_count: number;
	first_time: string;
	last_time: string;
}

function freqMinutes(
	cnt: number,
	firstTime: string,
	lastTime: string,
): number | null {
	const span = timeToMinutes(lastTime) - timeToMinutes(firstTime);
	return span > 0 && cnt > 1 ? span / (cnt - 1) : null;
}

function blendedDelay(row: DirRow): number | null {
	if (row.rt_count === 0 && row.cancelled === 0) return null;
	const rtSum = (row.avg_delay ?? 0) * row.rt_count;
	const freq = freqMinutes(row.total, row.first_time, row.last_time);
	const cancelledDelay = freq !== null ? row.cancelled * freq : 0;
	const total = row.rt_count + row.cancelled;
	return total > 0 ? (rtSum + cancelledDelay) / total : null;
}

function weightedAvg(
	items: { value: number | null; weight: number }[],
): number | null {
	const valid = items.filter(
		(i): i is { value: number; weight: number } => i.value !== null,
	);
	const totalWeight = valid.reduce((s, i) => s + i.weight, 0);
	return totalWeight > 0
		? valid.reduce((s, i) => s + i.value * i.weight, 0) / totalWeight
		: null;
}

function avgNonNull(nums: (number | null)[]): number | null {
	const valid = nums.filter((n): n is number => n !== null);
	return valid.length > 0
		? valid.reduce((a, b) => a + b, 0) / valid.length
		: null;
}

async function getStatsFallback(
	db: Db,
	station: Station,
	filter: QueryFilter = {},
): Promise<Stats> {
	const daysCond = daysCondition(departures.date, filter.days);
	const conditions = [eq(departures.stationId, station.id), CORE_HOURS];
	if (daysCond) conditions.push(daysCond);

	const [statsRows, lastChangeRows, haikuRows] = await Promise.all([
		db
			.select({
				date: departures.date,
				direction: departures.direction,
				total: count().as("total"),
				cancelled: sql<number>`SUM(${departures.cancelled})`.as("cancelled"),
				avg_delay: avgDelaySql.as("avg_delay"),
				rt_count: rtCountSql.as("rt_count"),
				first_time: sql<string>`MIN(${departures.time})`.as("first_time"),
				last_time: sql<string>`MAX(${departures.time})`.as("last_time"),
			})
			.from(departures)
			.where(and(...conditions))
			.groupBy(departures.date, departures.direction)
			.orderBy(desc(departures.date), departures.direction),
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

	const dayMap = new Map<string, { dirs: DirRow[] }>();
	for (const row of statsRows) {
		const dirRow: DirRow = {
			date: row.date,
			direction: row.direction,
			total: row.total,
			cancelled: row.cancelled,
			avg_delay: row.avg_delay,
			rt_count: row.rt_count,
			first_time: row.first_time,
			last_time: row.last_time,
		};
		const entry = dayMap.get(row.date) ?? { dirs: [] };
		entry.dirs.push(dirRow);
		dayMap.set(row.date, entry);
	}

	const days: DayStats[] = [...dayMap.entries()].map(([date, { dirs }]) => {
		const stationId = "";
		const total = dirs.reduce((s, d) => s + d.total, 0);
		const cancelled = dirs.reduce((s, d) => s + d.cancelled, 0);
		const avgDelay = weightedAvg(
			dirs.map((d) => ({ value: blendedDelay(d), weight: d.total })),
		);
		const plannedFreq = avgNonNull(
			dirs.map((d) => freqMinutes(d.total, d.first_time, d.last_time)),
		);
		const actualFreq = avgNonNull(
			dirs.map((d) =>
				freqMinutes(d.total - d.cancelled, d.first_time, d.last_time),
			),
		);
		return {
			stationId,
			date,
			total,
			cancelled,
			avgDelay,
			plannedFreq,
			actualFreq,
		};
	});

	const totalCancelled = days.reduce((s, d) => s + d.cancelled, 0);

	return {
		days,
		avgCancelledPerDay: days.length > 0 ? totalCancelled / days.length : 0,
		lastChange: lastChangeRows[0]?.fetchedAt ?? null,
		haiku: haikuRows[0]?.haiku ?? null,
	};
}

export interface StationSummary {
	cancelled: number;
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
						total: count().as("total"),
					})
					.from(departures)
					.where(and(CORE_HOURS, depDaysCond))
					.groupBy(departures.stationId)
			: db
					.select({
						stationId: stationDailyStats.stationId,
						cancelled: sum(stationDailyStats.cancelled).as("cancelled"),
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
			{ cancelled: Number(r.cancelled ?? 0), total: Number(r.total ?? 0) },
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
		avgDelay: d.avgDelay,
	}));
	return { days, lines: lineRows.map((r) => r.line) };
}

export function dayAvgDelay(departureRows: DepartureRow[]): number | null {
	const byDir = Map.groupBy(departureRows, (d) => d.direction);
	let totalDelay = 0;
	let delayCount = 0;
	for (const [, deps] of byDir) {
		const sorted = deps.toSorted((a, b) => a.time.localeCompare(b.time));
		const freq = freqMinutes(
			sorted.length,
			sorted[0].time,
			sorted[sorted.length - 1].time,
		);
		for (const d of sorted) {
			if (d.cancelled && freq !== null) {
				totalDelay += freq;
				delayCount++;
			} else if (!d.cancelled && d.rtTime && d.rtDate) {
				const scheduled = new Date(`${d.date}T${d.time}`).getTime();
				const actual = new Date(`${d.rtDate}T${d.rtTime}`).getTime();
				totalDelay += (actual - scheduled) / 60000;
				delayCount++;
			}
		}
	}
	return delayCount > 0 ? totalDelay / delayCount : null;
}

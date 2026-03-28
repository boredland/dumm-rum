import { and, count, desc, eq, sql, sum } from "drizzle-orm";
import type { Db } from "../db/client";
import { departures, haikus } from "../db/schema";
import type { Station } from "./stations";
import { nowBerlin, todayBerlin } from "./utils";

const CORE_HOURS = sql`((time >= '06:00:00' AND time < '09:00:00') OR (time >= '16:00:00' AND time < '19:00:00'))`;

function coreFilter(coreOnly: boolean) {
	return coreOnly ? CORE_HOURS : undefined;
}

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

export interface DayStats {
	date: string;
	total: number;
	cancelled: number;
	avgDelay: number | null;
	plannedFreq: number | null;
	actualFreq: number | null;
}

export interface DepartureRow {
	time: string;
	rt_time: string | null;
	line: string;
	direction: string;
	cancelled: number;
	fetched_at: string;
}

export interface NextDeparture {
	time: string;
	rt_time: string | null;
	direction: string;
	line: string;
}

export interface Stats {
	days: DayStats[];
	avgCancelledPerDay: number;
	lastChange: string | null;
	haiku: string | null;
}

function timeToMinutes(t: string): number {
	const [h, m] = t.split(":").map(Number);
	return h * 60 + m;
}

function freqMinutes(
	count: number,
	firstTime: string,
	lastTime: string,
): number | null {
	const span = timeToMinutes(lastTime) - timeToMinutes(firstTime);
	return span > 0 && count > 1 ? span / (count - 1) : null;
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

export async function getStats(
	db: Db,
	station: Station,
	coreOnly = false,
): Promise<Stats> {
	const core = coreFilter(coreOnly);

	const [statsRows, lastChangeRows, haikuRows] = await Promise.all([
		db.all<DirRow>(sql`
			SELECT date, direction, COUNT(*) as total, SUM(cancelled) as cancelled,
				AVG(CASE WHEN cancelled = 0 AND rt_time IS NOT NULL THEN
					(strftime('%s', rt_time) - strftime('%s', time)) / 60.0
				END) as avg_delay,
				SUM(CASE WHEN cancelled = 0 AND rt_time IS NOT NULL THEN 1 ELSE 0 END) as rt_count,
				MIN(time) as first_time, MAX(time) as last_time
			FROM departures WHERE station_id = ${station.id}
				${core ? sql`AND ${core}` : sql``}
			GROUP BY date, direction ORDER BY date DESC, direction
		`),
		db
			.select({ fetchedAt: departures.fetchedAt })
			.from(departures)
			.where(eq(departures.stationId, station.id))
			.orderBy(desc(departures.fetchedAt))
			.limit(1),
		db
			.select({ haiku: haikus.haiku })
			.from(haikus)
			.where(
				and(eq(haikus.date, todayBerlin()), eq(haikus.stationId, station.id)),
			)
			.limit(1),
	]);

	const dayMap = new Map<string, { dirs: DirRow[] }>();
	for (const row of statsRows) {
		const entry = dayMap.get(row.date) ?? { dirs: [] };
		entry.dirs.push(row);
		dayMap.set(row.date, entry);
	}

	const days: DayStats[] = [...dayMap.entries()].map(([date, { dirs }]) => {
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
		return { date, total, cancelled, avgDelay, plannedFreq, actualFreq };
	});

	const totalCancelled = days.reduce((s, d) => s + d.cancelled, 0);

	return {
		days,
		avgCancelledPerDay: days.length > 0 ? totalCancelled / days.length : 0,
		lastChange: lastChangeRows[0]?.fetchedAt ?? null,
		haiku: haikuRows[0]?.haiku ?? null,
	};
}

export async function getStationSummaries(
	db: Db,
	stations: Station[],
	coreOnly = false,
): Promise<Map<string, { cancelled: number; total: number }>> {
	const results = await Promise.all(
		stations.map((s) => {
			const conditions = [eq(departures.stationId, s.id)];
			const core = coreFilter(coreOnly);
			if (core) conditions.push(core);
			return db
				.select({
					cancelled: sum(departures.cancelled),
					total: count(),
				})
				.from(departures)
				.where(and(...conditions));
		}),
	);
	return new Map(
		stations.map((s, i) => {
			const row = results[i][0];
			return [
				s.id,
				{
					cancelled: Number(row?.cancelled ?? 0),
					total: Number(row?.total ?? 0),
				},
			] as const;
		}),
	);
}

export async function getDayDepartures(
	db: Db,
	station: Station,
	date: string,
): Promise<DepartureRow[]> {
	const rows = await db
		.select({
			time: departures.time,
			rt_time: departures.rtTime,
			line: departures.line,
			direction: departures.direction,
			cancelled: departures.cancelled,
			fetched_at: departures.fetchedAt,
		})
		.from(departures)
		.where(and(eq(departures.stationId, station.id), eq(departures.date, date)))
		.orderBy(departures.time, departures.direction);
	return rows;
}

export async function getHaiku(
	db: Db,
	station: Station,
	date: string,
): Promise<string | null> {
	const rows = await db
		.select({ haiku: haikus.haiku })
		.from(haikus)
		.where(and(eq(haikus.date, date), eq(haikus.stationId, station.id)))
		.limit(1);
	return rows[0]?.haiku ?? null;
}

export async function getNextDepartures(
	db: Db,
	station: Station,
): Promise<NextDeparture[]> {
	const rows = await db.all<NextDeparture>(sql`
		SELECT time, rt_time, direction, line FROM departures
		WHERE station_id = ${station.id} AND date = ${todayBerlin()}
			AND cancelled = 0 AND time >= ${nowBerlin().format("HH:mm:ss")}
		GROUP BY direction HAVING time = MIN(time)
		ORDER BY time
	`);
	return rows;
}

export interface OperatorSummary {
	operator: string;
	lines: string[];
	total: number;
	cancelled: number;
}

export async function getOperatorSummaries(
	db: Db,
	coreOnly = false,
): Promise<OperatorSummary[]> {
	const core = coreFilter(coreOnly);
	const rows = await db.all<{
		operator: string;
		line: string;
		total: number;
		cancelled: number;
	}>(sql`
		SELECT operator, line, COUNT(*) as total, SUM(cancelled) as cancelled
		FROM departures WHERE operator IS NOT NULL
			${core ? sql`AND ${core}` : sql``}
		GROUP BY operator, line ORDER BY operator, line
	`);

	const map = new Map<string, OperatorSummary>();
	for (const row of rows) {
		const existing = map.get(row.operator);
		if (existing) {
			existing.lines.push(row.line);
			existing.total += row.total;
			existing.cancelled += row.cancelled;
		} else {
			map.set(row.operator, {
				operator: row.operator,
				lines: [row.line],
				total: row.total,
				cancelled: row.cancelled,
			});
		}
	}
	return [...map.values()];
}

export interface OperatorDayStats {
	date: string;
	total: number;
	cancelled: number;
}

export async function getOperatorStats(
	db: Db,
	operator: string,
	coreOnly = false,
): Promise<{ days: OperatorDayStats[]; lines: string[] }> {
	const core = coreFilter(coreOnly);
	const [days, lineRows] = await Promise.all([
		db.all<OperatorDayStats>(sql`
			SELECT date, COUNT(*) as total, SUM(cancelled) as cancelled
			FROM departures WHERE operator = ${operator}
				${core ? sql`AND ${core}` : sql``}
			GROUP BY date ORDER BY date DESC
		`),
		db
			.selectDistinct({ line: departures.line })
			.from(departures)
			.where(eq(departures.operator, operator))
			.orderBy(departures.line),
	]);

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
			} else if (!d.cancelled && d.rt_time) {
				totalDelay += timeToMinutes(d.rt_time) - timeToMinutes(d.time);
				delayCount++;
			}
		}
	}
	return delayCount > 0 ? totalDelay / delayCount : null;
}

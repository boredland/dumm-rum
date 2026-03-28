import type { Station } from "./stations";
import { nowBerlin, todayBerlin } from "./utils";

const CORE_HOURS =
	"((time >= '06:00:00' AND time < '09:00:00') OR (time >= '16:00:00' AND time < '19:00:00'))";

function coreHoursFilter(coreOnly: boolean): string {
	return coreOnly ? `AND ${CORE_HOURS}` : "";
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
	db: D1Database,
	station: Station,
	coreOnly = false,
): Promise<Stats> {
	const coreFilter = coreHoursFilter(coreOnly);
	const [statsResult, lastChangeResult, haikuResult] = await db.batch([
		db
			.prepare(
				`SELECT date, direction, COUNT(*) as total, SUM(cancelled) as cancelled,
        AVG(CASE WHEN cancelled = 0 AND rt_time IS NOT NULL THEN
          (strftime('%s', rt_time) - strftime('%s', time)) / 60.0
        END) as avg_delay,
        SUM(CASE WHEN cancelled = 0 AND rt_time IS NOT NULL THEN 1 ELSE 0 END) as rt_count,
        MIN(time) as first_time, MAX(time) as last_time
       FROM departures WHERE station_id = ? ${coreFilter}
       GROUP BY date, direction ORDER BY date DESC, direction`,
			)
			.bind(station.id),
		db
			.prepare(
				"SELECT fetched_at FROM departures WHERE station_id = ? ORDER BY fetched_at DESC LIMIT 1",
			)
			.bind(station.id),
		db
			.prepare("SELECT haiku FROM haikus WHERE date = ? AND station_id = ?")
			.bind(todayBerlin(), station.id),
	]);

	const rows = (statsResult.results as DirRow[]) ?? [];
	const dayMap = new Map<string, { dirs: DirRow[] }>();
	for (const row of rows) {
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
	const lastChange =
		(lastChangeResult.results?.[0] as { fetched_at: string } | undefined)
			?.fetched_at ?? null;
	const haiku =
		(haikuResult.results?.[0] as { haiku: string } | undefined)?.haiku ?? null;

	return {
		days,
		avgCancelledPerDay: days.length > 0 ? totalCancelled / days.length : 0,
		lastChange,
		haiku,
	};
}

export async function getStationSummaries(
	db: D1Database,
	stations: Station[],
	coreOnly = false,
): Promise<Map<string, { cancelled: number; total: number }>> {
	const results = await db.batch(
		stations.map((s) =>
			db
				.prepare(
					`SELECT SUM(cancelled) as cancelled, COUNT(*) as total FROM departures WHERE station_id = ? ${coreHoursFilter(coreOnly)}`,
				)
				.bind(s.id),
		),
	);
	return new Map(
		stations.map((s, i) => {
			const row = results[i].results?.[0] as
				| { cancelled: number; total: number }
				| undefined;
			return [
				s.id,
				{ cancelled: row?.cancelled ?? 0, total: row?.total ?? 0 },
			] as const;
		}),
	);
}

export async function getDayDepartures(
	db: D1Database,
	station: Station,
	date: string,
): Promise<DepartureRow[]> {
	const { results } = await db
		.prepare(
			`SELECT time, rt_time, line, direction, cancelled, fetched_at FROM departures WHERE station_id = ? AND date = ? ORDER BY time, direction`,
		)
		.bind(station.id, date)
		.all<DepartureRow>();
	return results ?? [];
}

export async function getHaiku(
	db: D1Database,
	station: Station,
	date: string,
): Promise<string | null> {
	const row = await db
		.prepare("SELECT haiku FROM haikus WHERE date = ? AND station_id = ?")
		.bind(date, station.id)
		.first<{ haiku: string }>();
	return row?.haiku ?? null;
}

export async function getNextDepartures(
	db: D1Database,
	station: Station,
): Promise<NextDeparture[]> {
	const { results } = await db
		.prepare(
			`SELECT time, rt_time, direction, line FROM departures
       WHERE station_id = ? AND date = ? AND cancelled = 0 AND time >= ?
       GROUP BY direction HAVING time = MIN(time)
       ORDER BY time`,
		)
		.bind(station.id, todayBerlin(), nowBerlin().format("HH:mm:ss"))
		.all<NextDeparture>();
	return results ?? [];
}

export interface OperatorSummary {
	operator: string;
	lines: string[];
	total: number;
	cancelled: number;
}

export async function getOperatorSummaries(
	db: D1Database,
	coreOnly = false,
): Promise<OperatorSummary[]> {
	const { results } = await db
		.prepare(
			`SELECT operator, line, COUNT(*) as total, SUM(cancelled) as cancelled
       FROM departures WHERE operator IS NOT NULL ${coreHoursFilter(coreOnly)}
       GROUP BY operator, line ORDER BY operator, line`,
		)
		.all<{
			operator: string;
			line: string;
			total: number;
			cancelled: number;
		}>();

	const map = new Map<string, OperatorSummary>();
	for (const row of results ?? []) {
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
	db: D1Database,
	operator: string,
	coreOnly = false,
): Promise<{ days: OperatorDayStats[]; lines: string[] }> {
	const [daysResult, linesResult] = await db.batch([
		db
			.prepare(
				`SELECT date, COUNT(*) as total, SUM(cancelled) as cancelled
         FROM departures WHERE operator = ? ${coreHoursFilter(coreOnly)}
         GROUP BY date ORDER BY date DESC`,
			)
			.bind(operator),
		db
			.prepare(
				"SELECT DISTINCT line FROM departures WHERE operator = ? ORDER BY line",
			)
			.bind(operator),
	]);

	const days = (daysResult.results as OperatorDayStats[]) ?? [];
	const lines =
		(linesResult.results as { line: string }[])?.map((r) => r.line) ?? [];
	return { days, lines };
}

export function dayAvgDelay(departures: DepartureRow[]): number | null {
	const byDir = Map.groupBy(departures, (d) => d.direction);
	let totalDelay = 0;
	let count = 0;
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
				count++;
			} else if (!d.cancelled && d.rt_time) {
				totalDelay += timeToMinutes(d.rt_time) - timeToMinutes(d.time);
				count++;
			}
		}
	}
	return count > 0 ? totalDelay / count : null;
}

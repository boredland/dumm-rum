import { and, desc, eq, gte, isNotNull, sql, sum } from "drizzle-orm";
import { db } from "../db/client.ts";
import {
	journeyRuns,
	knownStops,
	lineDailyStats,
	operatorDailyStats,
} from "../db/schema.ts";
import { todayBerlin } from "./utils.ts";

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

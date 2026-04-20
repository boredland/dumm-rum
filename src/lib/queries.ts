import {
	and,
	asc,
	count,
	desc,
	eq,
	gte,
	inArray,
	isNotNull,
	ne,
	sql,
} from "drizzle-orm";
import { db } from "../db/client.ts";
import { journeyRuns, journeyStops, knownStops } from "../db/schema.ts";
import { DELAY_THRESHOLD_MIN, parseLineSlug, todayBerlin } from "./utils.ts";

// Reusable SQL fragments — Postgres boolean-aware.
const ghostCaseSql = sql<number>`CASE WHEN NOT ${journeyRuns.wasTracked} AND NOT ${journeyRuns.cancelled} THEN 1 ELSE 0 END`;

// Prefer departure timestamps — they're what riders wait for — but fall
// back to arrival when the stop has no dep_time (i.e. the terminus).
// Without this, a train that ran on time out of the origin but arrived
// 30 min late at its terminal was invisible to the delay metrics.
const stopDelayMinSql = sql<number>`COALESCE(
	CASE WHEN ${journeyStops.rtDepTime} IS NOT NULL AND ${journeyStops.depTime} IS NOT NULL THEN
		EXTRACT(EPOCH FROM (
			(${journeyStops.dayOfOperation} || ' ' || ${journeyStops.rtDepTime})::timestamp
			- (${journeyStops.dayOfOperation} || ' ' || ${journeyStops.depTime})::timestamp
		)) / 60.0
	END,
	CASE WHEN ${journeyStops.rtArrTime} IS NOT NULL AND ${journeyStops.arrTime} IS NOT NULL THEN
		EXTRACT(EPOCH FROM (
			(${journeyStops.dayOfOperation} || ' ' || ${journeyStops.rtArrTime})::timestamp
			- (${journeyStops.dayOfOperation} || ' ' || ${journeyStops.arrTime})::timestamp
		)) / 60.0
	END
)`;

const stopHasDelayDataSql = sql`(
	(${journeyStops.rtDepTime} IS NOT NULL AND ${journeyStops.depTime} IS NOT NULL)
	OR (${journeyStops.rtArrTime} IS NOT NULL AND ${journeyStops.arrTime} IS NOT NULL)
)`;

// Per-run "was delayed" signal, precomputed once across journey_stops so
// summary queries can LEFT JOIN instead of running a correlated EXISTS per
// row. The correlated form was ~6× slower on a 16k-run dataset — Postgres
// re-scanned the stops pk index once per run. Filter first + SELECT DISTINCT
// keeps the result small (one row per delayed run) and beats BOOL_OR across
// every row, because most stops aren't delayed.
function delayedByRunSq() {
	return db
		.selectDistinct({
			journeyRef: journeyStops.journeyRef,
			dayOfOperation: journeyStops.dayOfOperation,
		})
		.from(journeyStops)
		.where(
			sql`${stopHasDelayDataSql} AND ${stopDelayMinSql} >= ${DELAY_THRESHOLD_MIN}`,
		)
		.as("dbr");
}

function delayedJoinCondition(dbr: ReturnType<typeof delayedByRunSq>) {
	return and(
		eq(dbr.journeyRef, journeyRuns.journeyRef),
		eq(dbr.dayOfOperation, journeyRuns.dayOfOperation),
	);
}

function runDelayedSql(dbr: ReturnType<typeof delayedByRunSq>) {
	return sql<number>`SUM(CASE WHEN NOT ${journeyRuns.cancelled} AND ${dbr.journeyRef} IS NOT NULL THEN 1 ELSE 0 END)`;
}

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

// ─── Operator summaries ────────────────────────────────────────────────

export interface OperatorSummary {
	operator: string;
	lines: string[];
	categories: string[];
	total: number;
	cancelled: number;
	ghost: number;
	delayed: number;
}

export async function getOperatorSummaries(
	filter: QueryFilter = {},
): Promise<OperatorSummary[]> {
	const daysCond = daysCondition(filter.days);
	const hasOperator = and(
		isNotNull(journeyRuns.operator),
		ne(journeyRuns.operator, ""),
	);
	const dbr = delayedByRunSq();

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
				delayed: runDelayedSql(dbr).as("delayed"),
			})
			.from(journeyRuns)
			.leftJoin(dbr, delayedJoinCondition(dbr))
			.where(and(hasOperator, daysCond))
			.groupBy(journeyRuns.operator),
		db
			.select({
				operator: journeyRuns.operator,
				line: journeyRuns.line,
				category: journeyRuns.category,
			})
			.from(journeyRuns)
			.where(
				and(
					hasOperator,
					gte(
						journeyRuns.dayOfOperation,
						sql`to_char(CURRENT_DATE - INTERVAL '30 days', 'YYYY-MM-DD')`,
					),
				),
			)
			.groupBy(journeyRuns.operator, journeyRuns.line, journeyRuns.category)
			.orderBy(journeyRuns.operator, journeyRuns.category, journeyRuns.line),
	]);

	const lineMap = new Map<string, string[]>();
	const catMap = new Map<string, Set<string>>();
	for (const row of lineRows) {
		if (!row.operator) continue;
		const lines = lineMap.get(row.operator) ?? [];
		// Use composite slug for the line list so the UI can link correctly
		// without collisions between modes sharing a number.
		const slug =
			row.category && row.category !== "Bus"
				? `${row.category}:${row.line}`
				: row.line;
		lines.push(slug);
		lineMap.set(row.operator, lines);
		if (row.category) {
			const cats = catMap.get(row.operator) ?? new Set();
			cats.add(row.category);
			catMap.set(row.operator, cats);
		}
	}

	return statsRows
		.filter((r): r is typeof r & { operator: string } => r.operator != null)
		.map((r) => ({
			operator: r.operator,
			lines: lineMap.get(r.operator) ?? [],
			categories: [...(catMap.get(r.operator) ?? [])],
			total: Number(r.total),
			cancelled: Number(r.cancelled),
			ghost: Number(r.ghost),
			delayed: Number(r.delayed),
		}));
}

// ─── Line summaries ────────────────────────────────────────────────────

export interface LineSummary {
	line: string;
	category: string;
	slug: string;
	operators: string[];
	destinations: string[];
	total: number;
	cancelled: number;
	ghost: number;
	delayed: number;
}

export async function getLineSummaries(
	filter: QueryFilter = {},
): Promise<LineSummary[]> {
	const daysCond = daysCondition(filter.days);
	const dbr = delayedByRunSq();
	const rows = await db
		.select({
			line: journeyRuns.line,
			category: journeyRuns.category,
			total: count().as("total"),
			cancelled:
				sql<number>`SUM(CASE WHEN ${journeyRuns.cancelled} THEN 1 ELSE 0 END)`.as(
					"cancelled",
				),
			ghost: sql<number>`SUM(${ghostCaseSql})`.as("ghost"),
			delayed: runDelayedSql(dbr).as("delayed"),
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
		.leftJoin(dbr, delayedJoinCondition(dbr))
		.where(daysCond)
		.groupBy(journeyRuns.line, journeyRuns.category)
		.orderBy(journeyRuns.category, journeyRuns.line);

	return rows.map((r) => {
		const category = r.category ?? "Bus";
		return {
			line: r.line,
			category,
			slug: category !== "Bus" ? `${category}:${r.line}` : r.line,
			operators: r.operators ? dedupeCsv(r.operators) : [],
			destinations: r.destinations ? dedupeCsv(r.destinations) : [],
			total: Number(r.total),
			cancelled: Number(r.cancelled),
			ghost: Number(r.ghost),
			delayed: Number(r.delayed),
		};
	});
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
				AND ${stopHasDelayDataSql}
				AND ${stopDelayMinSql} >= ${DELAY_THRESHOLD_MIN}
			THEN 1 ELSE 0 END)`.as("delayed"),
			lines:
				sql<string>`STRING_AGG(DISTINCT (CASE WHEN ${journeyRuns.category} IS NOT NULL AND ${journeyRuns.category} <> 'Bus' THEN ${journeyRuns.category} || ':' || ${journeyRuns.line} ELSE ${journeyRuns.line} END), ',')`.as(
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
}

export interface LineStats {
	days: LineDayStats[];
	operators: string[];
	categories: string[];
	destinations: string[];
}

/** Per-day stats for one line, ad-hoc from journey_runs. */
export async function getLineStats(lineSlug: string): Promise<LineStats> {
	const { line, category } = parseLineSlug(lineSlug);
	const dbr = delayedByRunSq();

	const where = category
		? and(eq(journeyRuns.line, line), eq(journeyRuns.category, category))
		: eq(journeyRuns.line, line);

	const rows = await db
		.select({
			date: journeyRuns.dayOfOperation,
			total: count().as("total"),
			cancelled:
				sql<number>`SUM(CASE WHEN ${journeyRuns.cancelled} THEN 1 ELSE 0 END)`.as(
					"cancelled",
				),
			ghost: sql<number>`SUM(${ghostCaseSql})`.as("ghost"),
			delayed: runDelayedSql(dbr).as("delayed"),
		})
		.from(journeyRuns)
		.leftJoin(dbr, delayedJoinCondition(dbr))
		.where(where)
		.groupBy(journeyRuns.dayOfOperation)
		.orderBy(desc(journeyRuns.dayOfOperation));

	const [opRows, catRows, destRows] = await Promise.all([
		db
			.selectDistinct({ operator: journeyRuns.operator })
			.from(journeyRuns)
			.where(
				and(
					where,
					isNotNull(journeyRuns.operator),
					ne(journeyRuns.operator, ""),
				),
			),
		db
			.selectDistinct({ category: journeyRuns.category })
			.from(journeyRuns)
			.where(and(where, isNotNull(journeyRuns.category))),
		db
			.selectDistinct({ dest: journeyRuns.destName })
			.from(journeyRuns)
			.where(where),
	]);

	return {
		days: rows.map((d) => ({
			date: d.date,
			total: Number(d.total),
			cancelled: Number(d.cancelled),
			ghost: Number(d.ghost),
			delayed: Number(d.delayed),
		})),
		operators: opRows.map((r) => r.operator).filter((o): o is string => !!o),
		categories: catRows.map((r) => r.category).filter((c): c is string => !!c),
		destinations: destRows.map((r) => r.dest).filter(Boolean),
	};
}

export interface LineDayJourney {
	journeyRef: string;
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
	lineSlug: string,
	date: string,
): Promise<LineDayJourney[]> {
	const { line, category } = parseLineSlug(lineSlug);
	const where = category
		? and(
				eq(journeyRuns.line, line),
				eq(journeyRuns.category, category),
				eq(journeyRuns.dayOfOperation, date),
			)
		: and(eq(journeyRuns.line, line), eq(journeyRuns.dayOfOperation, date));

	const rows = await db
		.select({
			journeyRef: journeyRuns.journeyRef,
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
		.where(where)
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
}

export interface OperatorStats {
	days: OperatorDayStats[];
	lines: string[];
	categories: string[];
}

export async function getOperatorStats(
	operator: string,
): Promise<OperatorStats> {
	const dbr = delayedByRunSq();
	const rows = await db
		.select({
			date: journeyRuns.dayOfOperation,
			total: count().as("total"),
			cancelled:
				sql<number>`SUM(CASE WHEN ${journeyRuns.cancelled} THEN 1 ELSE 0 END)`.as(
					"cancelled",
				),
			ghost: sql<number>`SUM(${ghostCaseSql})`.as("ghost"),
			delayed: runDelayedSql(dbr).as("delayed"),
		})
		.from(journeyRuns)
		.leftJoin(dbr, delayedJoinCondition(dbr))
		.where(eq(journeyRuns.operator, operator))
		.groupBy(journeyRuns.dayOfOperation)
		.orderBy(desc(journeyRuns.dayOfOperation));

	const [lineRows, catRows] = await Promise.all([
		db
			.selectDistinct({
				line: journeyRuns.line,
				category: journeyRuns.category,
			})
			.from(journeyRuns)
			.where(eq(journeyRuns.operator, operator))
			.orderBy(journeyRuns.category, journeyRuns.line),
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
		})),
		lines: lineRows.map((r) =>
			r.category && r.category !== "Bus" ? `${r.category}:${r.line}` : r.line,
		),
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

// Three-layer cascade because WorstCard links to stops via `nameToSlug(stop_name)`
// from journey_stops, but known_stops (the rollup) may not have caught up yet.
export async function findStopBySlug(slug: string): Promise<KnownStop | null> {
	const rows = await db
		.select({
			stopId: knownStops.stopId,
			stopName: knownStops.stopName,
			categories: knownStops.categories,
		})
		.from(knownStops)
		.where(eq(knownStops.slug, slug));
	if (rows.length > 0) return mergeStopRows(rows);

	const { nameToSlug } = await import("./stations.ts");
	const candidates = await db
		.select({
			stopId: knownStops.stopId,
			stopName: knownStops.stopName,
			categories: knownStops.categories,
		})
		.from(knownStops);
	const match = candidates.filter((r) => nameToSlug(r.stopName) === slug);
	if (match.length > 0) return mergeStopRows(match);

	// nameToSlug isn't deterministic in SQL (umlaut transliteration + NFD in JS),
	// so group in SQL and match in app memory.
	const live = await db
		.select({
			stopId: journeyStops.stopId,
			stopName: sql<string>`MIN(${journeyStops.stopName})`.as("stop_name"),
		})
		.from(journeyStops)
		.groupBy(journeyStops.stopId);
	const liveMatch = live.filter((r) => nameToSlug(r.stopName) === slug);
	if (liveMatch.length === 0) return null;
	const categoriesRow = await db
		.select({
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
			inArray(
				journeyStops.stopId,
				liveMatch.map((r) => r.stopId),
			),
		);
	const categories = categoriesRow[0]?.categories ?? null;
	return mergeStopRows(
		liveMatch.map((r) => ({
			stopId: r.stopId,
			stopName: r.stopName,
			categories,
		})),
	);
}

function mergeStopRows(
	rows: { stopId: string; stopName: string; categories: string | null }[],
): KnownStop {
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
						AND ${stopHasDelayDataSql}
						AND ${stopDelayMinSql} >= ${DELAY_THRESHOLD_MIN}
					THEN 1 ELSE 0 END)
				`.as("delayed"),
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
			line: sql<string>`(CASE WHEN ${journeyRuns.category} IS NOT NULL AND ${journeyRuns.category} <> 'Bus' THEN ${journeyRuns.category} || ':' || ${journeyRuns.line} ELSE ${journeyRuns.line} END)`.as(
				"line",
			),
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

/** Earliest day_of_operation across all journey_runs. */
export async function getOldestDate(): Promise<string | null> {
	const rows = await db
		.select({
			date: sql<string | null>`MIN(${journeyRuns.dayOfOperation})`,
		})
		.from(journeyRuns);
	return rows[0]?.date ?? null;
}

export interface StopPickerEntry {
	/** Canonical display name (Groups multi-platform stops by name). */
	name: string;
}

/** All distinct stop names known to the system. Intended for client-side
 * fuzzy search in the subscribe modal — heavy cache at the HTTP layer. */
export async function getAllStopNames(): Promise<StopPickerEntry[]> {
	const rows = await db
		.select({
			name: sql<string>`MIN(${knownStops.stopName})`.as("name"),
		})
		.from(knownStops)
		.groupBy(sql`LOWER(${knownStops.stopName})`)
		.orderBy(sql`MIN(${knownStops.stopName})`);
	return rows.map((r) => ({ name: r.name })).filter((r) => r.name);
}

/** All distinct line codes seen in journey_runs. */
export async function getAllLineNames(): Promise<string[]> {
	const rows = await db
		.selectDistinct({ line: journeyRuns.line, category: journeyRuns.category })
		.from(journeyRuns)
		.where(isNotNull(journeyRuns.line))
		.orderBy(journeyRuns.category, journeyRuns.line);
	return rows
		.map((r) =>
			r.category && r.category !== "Bus" ? `${r.category}:${r.line}` : r.line,
		)
		.filter(Boolean);
}

/** All distinct destinations (headsigns) seen in journey_runs. */
export async function getAllDirections(): Promise<string[]> {
	const rows = await db
		.selectDistinct({ dest: journeyRuns.destName })
		.from(journeyRuns)
		.where(isNotNull(journeyRuns.destName))
		.orderBy(journeyRuns.destName);
	return rows.map((r) => r.dest).filter(Boolean);
}

/** All distinct destinations a given line has run to in the last 30 days. */
export async function getDirectionsForLine(
	lineSlug: string,
): Promise<string[]> {
	const { line, category } = parseLineSlug(lineSlug);
	const where = category
		? and(eq(journeyRuns.line, line), eq(journeyRuns.category, category))
		: eq(journeyRuns.line, line);

	const rows = await db
		.selectDistinct({ dest: journeyRuns.destName })
		.from(journeyRuns)
		.where(
			and(
				where,
				isNotNull(journeyRuns.destName),
				gte(
					journeyRuns.dayOfOperation,
					sql`to_char(CURRENT_DATE - INTERVAL '30 days', 'YYYY-MM-DD')`,
				),
			),
		)
		.orderBy(journeyRuns.destName);
	return rows.map((r) => r.dest).filter(Boolean);
}

/** All distinct stop names served by a line in the last 30 days. */
export async function getStopsForLine(lineSlug: string): Promise<string[]> {
	const { line, category } = parseLineSlug(lineSlug);
	const where = category
		? and(eq(journeyRuns.line, line), eq(journeyRuns.category, category))
		: eq(journeyRuns.line, line);

	const rows = await db
		.selectDistinct({
			name: journeyStops.stopName,
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
				where,
				gte(
					journeyStops.dayOfOperation,
					sql`to_char(CURRENT_DATE - INTERVAL '30 days', 'YYYY-MM-DD')`,
				),
			),
		)
		.orderBy(journeyStops.stopName);
	return rows.map((r) => r.name).filter(Boolean);
}

function dedupeCsv(s: string): string[] {
	return [...new Set(s.split(","))].filter(Boolean);
}

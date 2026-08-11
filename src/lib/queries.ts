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
	type SQL,
	sql,
} from "drizzle-orm";
import { db } from "../db/client.ts";
import { journeyRuns, journeyStops, knownStops } from "../db/schema.ts";
import {
	DELAY_THRESHOLD_MIN,
	lineSlug,
	parseLineSlug,
	todayBerlin,
} from "./utils.ts";

const ghostCaseSql = sql<number>`CASE WHEN NOT ${journeyRuns.wasTracked} AND NOT ${journeyRuns.cancelled} THEN 1 ELSE 0 END`;

const sourceSql = sql<string>`CASE
	WHEN ${journeyRuns.journeyRef} ~ '^[12]\|' THEN 'rmv'
	ELSE 'unknown'
END`;

/** HAFAS category -> display bucket. The CASE lives in Postgres as
 * `normalize_category` (see drizzle/20260811090000_normalize_category_fn)
 * so SQL and TS cannot drift. The function absorbs NULL itself: wrapping
 * the call in COALESCE here would stop matching the functional index and
 * seq-scan journey_runs on every category filter.
 *
 * Exported because every producer of a `source:category:line` slug must
 * use the same bucket — a raw category yields a slug no lookup resolves. */
export const normalizedCategorySql = sql<string>`normalize_category(${journeyRuns.category})`;

/** Long-distance traffic (ICE / IC / EC / ECE / NJ / EN / RJ / RJX / TGV
 * / EST) is still ingested — see the rationale in discover.ts — but never
 * displayed. Applied in every read query rather than filtered in the UI
 * so headline totals, worst-offender cards and section counts can't
 * disagree with the lists they summarize. Exported for the alert path,
 * which reads journey_runs directly. */
export const DISPLAYED_CATEGORY = sql`${normalizedCategorySql} <> 'Fernverkehr'`;

const lineSlugSql = sql<string>`(${sourceSql} || ':' || ${normalizedCategorySql} || ':' || ${journeyRuns.line})`;

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
		.where(gte(journeyStops.delayMin, DELAY_THRESHOLD_MIN))
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
	until?: string; // ISO date string (YYYY-MM-DD), used for cacheable "until" queries
}

function last30DaysSql(until?: string): SQL {
	if (until) {
		return sql`${journeyRuns.dayOfOperation} >= to_char(cast(${until} as date) - INTERVAL '30 days', 'YYYY-MM-DD')`;
	}
	return sql`${journeyRuns.dayOfOperation} >= to_char(CURRENT_DATE - INTERVAL '30 days', 'YYYY-MM-DD')`;
}

function daysCondition(filter: DaysFilter = "today", until?: string) {
	if (filter === "today") return eq(journeyRuns.dayOfOperation, todayBerlin());
	const last30 = last30DaysSql(until);
	if (filter === "weekdays")
		return sql`${last30} AND EXTRACT(DOW FROM ${journeyRuns.dayOfOperation}::date)::int NOT IN (0, 6)`;
	if (filter === "weekends")
		return sql`${last30} AND EXTRACT(DOW FROM ${journeyRuns.dayOfOperation}::date)::int IN (0, 6)`;
	return last30;
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
	const daysCond = daysCondition(filter.days, filter.until);
	const hasOperator = and(
		isNotNull(journeyRuns.operator),
		ne(journeyRuns.operator, ""),
		DISPLAYED_CATEGORY,
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
				category: normalizedCategorySql.as("category"),
				source: sourceSql.as("source"),
			})
			.from(journeyRuns)
			.where(and(hasOperator, daysCond))
			.groupBy(
				journeyRuns.operator,
				journeyRuns.line,
				normalizedCategorySql,
				sourceSql,
			)
			.orderBy(journeyRuns.operator, normalizedCategorySql, journeyRuns.line),
	]);

	const lineMap = new Map<string, string[]>();
	const catMap = new Map<string, Set<string>>();
	for (const row of lineRows) {
		if (!row.operator) continue;
		const lines = lineMap.get(row.operator) ?? [];
		lines.push(lineSlug(row.source, row.category, row.line));
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
	const daysCond = daysCondition(filter.days, filter.until);
	const dbr = delayedByRunSq();
	const rows = await db
		.select({
			line: journeyRuns.line,
			category: normalizedCategorySql.as("category"),
			source: sourceSql.as("source"),
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
		.where(and(daysCond, DISPLAYED_CATEGORY))
		.groupBy(journeyRuns.line, normalizedCategorySql, sourceSql)
		.orderBy(normalizedCategorySql, journeyRuns.line);

	return rows.map((r) => ({
		line: r.line,
		category: r.category,
		slug: lineSlug(r.source, r.category, r.line),
		operators: r.operators ? dedupeCsv(r.operators) : [],
		destinations: r.destinations ? dedupeCsv(r.destinations) : [],
		total: Number(r.total),
		cancelled: Number(r.cancelled),
		ghost: Number(r.ghost),
		delayed: Number(r.delayed),
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

/** Ad-hoc aggregation of journey_stops for the last 7 days, grouped by stop.
 *
 * Split into two parallel queries so the planner never has to sort 1.2M
 * stop-visit rows for DISTINCT aggregation: the counts pass uses plain
 * aggregates and the lines pass hash-dedupes down to ~10k (stop, line,
 * category, source) tuples before the STRING_AGG. Merged back by stop_id
 * in JS. Same result shape as the single-query version, 20–30× faster. */
export async function getStopSummaries(): Promise<StopSummary[]> {
	const dayWindow = sql`${journeyStops.dayOfOperation} >= to_char(CURRENT_DATE - INTERVAL '7 days', 'YYYY-MM-DD')`;

	const [countsRows, linesRows] = await Promise.all([
		db
			.select({
				stopId: journeyStops.stopId,
				stopName: sql<string>`MIN(${journeyStops.stopName})`.as("stop_name"),
				journeyCount: sql<number>`COUNT(*)`.as("journey_count"),
				cancelled:
					sql<number>`SUM(CASE WHEN ${journeyStops.cancelled} THEN 1 ELSE 0 END)`.as(
						"cancelled",
					),
				ghost: sql<number>`SUM(${ghostCaseSql})`.as("ghost"),
				delayed: sql<number>`SUM(CASE WHEN NOT ${journeyStops.cancelled}
					AND ${journeyStops.delayMin} >= ${DELAY_THRESHOLD_MIN}
				THEN 1 ELSE 0 END)`.as("delayed"),
			})
			.from(journeyStops)
			.leftJoin(
				journeyRuns,
				and(
					eq(journeyRuns.journeyRef, journeyStops.journeyRef),
					eq(journeyRuns.dayOfOperation, journeyStops.dayOfOperation),
				),
			)
			.where(and(dayWindow, DISPLAYED_CATEGORY))
			.groupBy(journeyStops.stopId)
			.orderBy(desc(sql`COUNT(*)`)),
		db.execute(sql<{
			stop_id: string;
			lines: string | null;
			categories: string | null;
		}>`
			WITH distinct_stop_lines AS (
				SELECT DISTINCT
					${journeyStops.stopId} AS stop_id,
					${journeyRuns.line} AS line,
					${normalizedCategorySql} AS category,
					${sourceSql} AS source
				FROM ${journeyStops}
				LEFT JOIN ${journeyRuns}
					ON ${journeyRuns.journeyRef} = ${journeyStops.journeyRef}
					AND ${journeyRuns.dayOfOperation} = ${journeyStops.dayOfOperation}
				WHERE ${dayWindow} AND ${DISPLAYED_CATEGORY}
			)
			SELECT
				stop_id,
				STRING_AGG(source || ':' || category || ':' || line, ',') AS lines,
				STRING_AGG(DISTINCT category, ',') AS categories
			FROM distinct_stop_lines
			GROUP BY stop_id
		`),
	]);

	const linesByStop = new Map<
		string,
		{ lines: string | null; categories: string | null }
	>();
	for (const row of linesRows as unknown as {
		stop_id: string;
		lines: string | null;
		categories: string | null;
	}[]) {
		linesByStop.set(row.stop_id, {
			lines: row.lines,
			categories: row.categories,
		});
	}

	return countsRows.map((r) => {
		const l = linesByStop.get(r.stopId);
		return {
			stopIds: [r.stopId],
			stopName: r.stopName,
			journeyCount: Number(r.journeyCount ?? 0),
			cancelled: Number(r.cancelled ?? 0),
			ghost: Number(r.ghost ?? 0),
			delayed: Number(r.delayed ?? 0),
			lines: l?.lines ? dedupeCsv(l.lines) : [],
			categories: l?.categories ? dedupeCsv(l.categories) : [],
		};
	});
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
export async function getLineStats(slug: string): Promise<LineStats> {
	const { line, category, source } = parseLineSlug(slug);
	const dbr = delayedByRunSq();

	let where: SQL | undefined = and(
		eq(journeyRuns.line, line),
		DISPLAYED_CATEGORY,
	);
	if (category) where = and(where, eq(normalizedCategorySql, category));
	if (source) where = and(where, eq(sourceSql, source));

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
			.selectDistinct({ category: normalizedCategorySql.as("category") })
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
	slug: string,
	date: string,
): Promise<LineDayJourney[]> {
	const { line, category, source } = parseLineSlug(slug);
	let where = and(
		eq(journeyRuns.line, line),
		eq(journeyRuns.dayOfOperation, date),
		DISPLAYED_CATEGORY,
	);
	if (category) where = and(where, eq(normalizedCategorySql, category));
	if (source) where = and(where, eq(sourceSql, source));

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
			category: normalizedCategorySql.as("category"),
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
		.where(and(eq(journeyRuns.operator, operator), DISPLAYED_CATEGORY))
		.groupBy(journeyRuns.dayOfOperation)
		.orderBy(desc(journeyRuns.dayOfOperation));

	const [lineRows, catRows] = await Promise.all([
		db
			.selectDistinct({
				line: journeyRuns.line,
				category: normalizedCategorySql.as("category"),
				source: sourceSql.as("source"),
			})
			.from(journeyRuns)
			.where(and(eq(journeyRuns.operator, operator), DISPLAYED_CATEGORY))
			.orderBy(normalizedCategorySql, journeyRuns.line),
		db
			.selectDistinct({ category: normalizedCategorySql.as("category") })
			.from(journeyRuns)
			.where(
				and(
					eq(journeyRuns.operator, operator),
					isNotNull(journeyRuns.category),
					DISPLAYED_CATEGORY,
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
		lines: lineRows.map((r) => lineSlug(r.source, r.category, r.line)),
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
			category: normalizedCategorySql.as("category"),
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
				DISPLAYED_CATEGORY,
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
}

/** Resolve a stop slug to its ids + display name.
 *
 * One indexed lookup on `known_stops.slug`, which the poller writes for
 * every stop it sees (upsertKnownStops). This used to be a three-layer
 * cascade whose fallbacks scanned all of known_stops and then grouped the
 * whole of journey_stops — unbounded work per distinct slug, with no memo
 * protection at all against slugs that don't exist.
 *
 * Several stop ids can share a slug (a multi-platform station resolves to
 * one name), so every match is returned; the display name is pinned to the
 * lowest id so a reload can't flip between platform name variants. */
export async function findStopBySlug(slug: string): Promise<KnownStop | null> {
	const rows = await db
		.select({ stopId: knownStops.stopId, stopName: knownStops.stopName })
		.from(knownStops)
		.where(eq(knownStops.slug, slug))
		.orderBy(asc(knownStops.stopId));
	if (rows.length === 0) return null;
	return {
		stopIds: rows.map((r) => r.stopId),
		stopName: rows[0].stopName,
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
						AND ${journeyStops.delayMin} >= ${DELAY_THRESHOLD_MIN}
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
			.where(and(inArray(journeyStops.stopId, stopIds), DISPLAYED_CATEGORY))
			.groupBy(journeyStops.dayOfOperation)
			.orderBy(desc(journeyStops.dayOfOperation)),
		db
			.select({
				lastChange: sql<string | null>`MAX(${journeyRuns.snapshotAt})`.as(
					"last_change",
				),
				categories:
					sql<string>`STRING_AGG(DISTINCT ${normalizedCategorySql}, ',')`.as(
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
			.where(and(inArray(journeyStops.stopId, stopIds), DISPLAYED_CATEGORY)),
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
			line: sql<string>`${lineSlugSql}`.as("line"),
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
				DISPLAYED_CATEGORY,
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

/** All distinct stop names seen in the last 30 days, deduped case-insensitively.
 * Intended for client-side fuzzy search in the subscribe modal — heavy cache
 * at the HTTP layer. Backed by `idx_journey_stops_day_name`. */
export async function getAllStopNames(): Promise<StopPickerEntry[]> {
	const rows = await db
		.select({
			name: sql<string>`MIN(${journeyStops.stopName})`.as("name"),
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
				sql`${journeyStops.dayOfOperation} >= to_char(CURRENT_DATE - INTERVAL '30 days', 'YYYY-MM-DD')`,
				DISPLAYED_CATEGORY,
			),
		)
		.groupBy(sql`LOWER(${journeyStops.stopName})`)
		.orderBy(sql`MIN(${journeyStops.stopName})`);
	return rows.map((r) => ({ name: r.name })).filter((r) => r.name);
}

/** All distinct line codes seen in journey_runs. */
export async function getAllLineNames(): Promise<string[]> {
	const rows = await db
		.selectDistinct({
			line: journeyRuns.line,
			category: normalizedCategorySql.as("category"),
			source: sourceSql.as("source"),
		})
		.from(journeyRuns)
		.where(and(isNotNull(journeyRuns.line), DISPLAYED_CATEGORY))
		.orderBy(normalizedCategorySql, journeyRuns.line);
	return rows
		.map((r) => lineSlug(r.source, r.category, r.line))
		.filter(Boolean);
}

/** All distinct destinations (headsigns) seen in journey_runs. */
export async function getAllDirections(): Promise<string[]> {
	const rows = await db
		.selectDistinct({ dest: journeyRuns.destName })
		.from(journeyRuns)
		.where(and(isNotNull(journeyRuns.destName), DISPLAYED_CATEGORY))
		.orderBy(journeyRuns.destName);
	return rows.map((r) => r.dest).filter(Boolean);
}

/** All distinct destinations a given line has run to in the last 30 days. */
export async function getDirectionsForLine(slug: string): Promise<string[]> {
	const { line, category } = parseLineSlug(slug);
	const where = and(
		eq(journeyRuns.line, line),
		DISPLAYED_CATEGORY,
		category ? eq(normalizedCategorySql, category) : undefined,
	);

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
export async function getStopsForLine(slug: string): Promise<string[]> {
	const { line, category } = parseLineSlug(slug);
	const where = and(
		eq(journeyRuns.line, line),
		DISPLAYED_CATEGORY,
		category ? eq(normalizedCategorySql, category) : undefined,
	);

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

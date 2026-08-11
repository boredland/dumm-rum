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

/** HAFAS category -> display bucket. Reads the stored `category_norm`
 * column rather than calling `normalize_category` per row: the function
 * runs several regex arms, so grouping on the call cost ~5x the column
 * (74 ms against 13 ms over 30 days of runs).
 *
 * Exported because every producer of a `source:category:line` slug must
 * use the same bucket — a raw category yields a slug no lookup resolves. */
export const normalizedCategorySql = sql<string>`${journeyRuns.categoryNorm}`;

/** Traffic this site reports on. Long-distance trains and Mainz city buses
 * are neither ingested nor stored any more, so this filter normally matches
 * everything.
 *
 * It stays as a safety net. The ingest filter in discover.ts is a TS list
 * plus a prefix regex; normalize_category is the SQL source of truth. If
 * the two ever disagree, a run can still land in the Fernverkehr bucket,
 * and this keeps it off the site until the ingest list catches up.
 *
 * Two clauses beyond the category. The operator one covers Mainz city
 * buses, which the ingest also rejects (EXCLUDE_OPERATORS in discover.ts).
 * The poll-state one covers the rest: the poller can only tombstone a run
 * it recognises late, and such a run keeps an ordinary bus category, so the
 * line and operator summaries — which read journey_runs directly, not its
 * stops — would otherwise count a run with no stops left.
 *
 * Applied in every read query rather than in the UI, so headline totals,
 * worst-offender cards and section counts cannot disagree with the lists
 * they summarize. Exported for the alert path, which reads journey_runs
 * directly. */
export const COLLECTED_TRAFFIC = sql`${normalizedCategorySql} <> 'Fernverkehr'
	AND (${journeyRuns.operator} IS NULL OR ${journeyRuns.operator} <> 'Mainzer Mobilität')
	AND (${journeyRuns.pollState} IS NULL OR ${journeyRuns.pollState} <> 'excluded')`;

const lineSlugSql = sql<string>`(${sourceSql} || ':' || ${normalizedCategorySql} || ':' || ${journeyRuns.line})`;

// Per-run "was delayed" signal, precomputed once across journey_stops so
// summary queries can LEFT JOIN instead of probing per run. Filter first +
// SELECT DISTINCT keeps the result small (one row per delayed run) and beats
// BOOL_OR across every row, because most stops aren't delayed.
//
// This is the right shape only when the caller reads most of the window
// anyway. The entity detail pages read one line or one operator, so they use
// runDelayedCorrelatedSql below instead.
function delayedByRunSq(until?: string, bounded = false) {
	// Bounded to the caller's own window where it has one. Unbounded, this
	// walked every delayed stop ever recorded — 493k index entries and
	// growing, to answer a question about 30 days.
	//
	// The bound must mirror last30DaysSql exactly, `until` included: with an
	// `until` the caller reads the 30 days before THAT date, so anchoring on
	// CURRENT_DATE would drop delayed runs the summary still counts.
	const where = bounded
		? and(
				gte(journeyStops.delayMin, DELAY_THRESHOLD_MIN),
				until
					? sql`${journeyStops.dayOfOperation} >= to_char(cast(${until} as date) - INTERVAL '30 days', 'YYYY-MM-DD')`
					: sql`${journeyStops.dayOfOperation} >= ${sinceDays(30)}`,
			)
		: gte(journeyStops.delayMin, DELAY_THRESHOLD_MIN);
	return db
		.selectDistinct({
			journeyRef: journeyStops.journeyRef,
			dayOfOperation: journeyStops.dayOfOperation,
		})
		.from(journeyStops)
		.where(where)
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

/** Same "was this run delayed" signal as the joinable subquery, correlated
 * per run instead of precomputed across the table.
 *
 * For the entity detail pages this is the cheaper shape: the join form has
 * no line or operator to push down, so it walks every delayed stop ever
 * recorded (493k index entries, growing without bound) to report on one
 * line. The correlated form probes `idx_journey_stops_delay_min` once per
 * run of that line, and cost scales with the entity, not with history:
 * 60 ms against 9 ms.
 *
 * The summary queries keep the join form. They read every run in the
 * window, so one pass beats a probe per run. */
const runDelayedCorrelatedSql = sql<number>`SUM(CASE WHEN NOT ${journeyRuns.cancelled} AND EXISTS (
	SELECT 1 FROM ${journeyStops}
	WHERE ${journeyStops.journeyRef} = "journey_runs"."journey_ref"
		AND ${journeyStops.dayOfOperation} = "journey_runs"."day_of_operation"
		AND ${journeyStops.delayMin} >= ${DELAY_THRESHOLD_MIN}
) THEN 1 ELSE 0 END)`;

/** Today in Berlin, as the database sees it.
 *
 * `day_of_operation` is a Berlin-local HAFAS service date, but the server
 * runs UTC, so a plain CURRENT_DATE is a day behind between 22:00 UTC and
 * midnight. Every window below anchors here instead, so the boundaries
 * cannot disagree with `todayBerlin()` in the app. */
const berlinToday = sql`(now() AT TIME ZONE 'Europe/Berlin')::date`;

/** A `day_of_operation >= N days ago` bound, anchored on Berlin time.
 * Exported so the alert path uses the same boundary as the read queries. */
export function sinceDays(days: number): SQL {
	return sql`to_char(${berlinToday} - ${sql.raw(`INTERVAL '${days} days'`)}, 'YYYY-MM-DD')`;
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
	return sql`${journeyRuns.dayOfOperation} >= ${sinceDays(30)}`;
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
		COLLECTED_TRAFFIC,
	);
	const dbr = delayedByRunSq(filter.until, true);

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
	const dbr = delayedByRunSq(filter.until, true);
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
				sql<string>`STRING_AGG(DISTINCT ${journeyRuns.operator}, ',' ORDER BY ${journeyRuns.operator})`.as(
					"operators",
				),
			destinations:
				sql<string>`STRING_AGG(DISTINCT ${journeyRuns.destName}, ',' ORDER BY ${journeyRuns.destName})`.as(
					"destinations",
				),
		})
		.from(journeyRuns)
		.leftJoin(dbr, delayedJoinCondition(dbr))
		.where(and(daysCond, COLLECTED_TRAFFIC))
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
	const dayWindow = sql`${journeyStops.dayOfOperation} >= ${sinceDays(7)}`;
	// The same bound on the run side of the join. It adds no rows — the join
	// matches on day_of_operation anyway — but it lets the planner build the
	// hash from 7 days of runs instead of every row ever ingested, which is
	// what made the join spill to disk (84 ms against 55 ms).
	const runDayWindow = sql`${journeyRuns.dayOfOperation} >= ${sinceDays(7)}`;

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
			.where(and(dayWindow, runDayWindow, COLLECTED_TRAFFIC))
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
				WHERE ${dayWindow} AND ${runDayWindow} AND ${COLLECTED_TRAFFIC}
			)
			SELECT
				stop_id,
				STRING_AGG(source || ':' || category || ':' || line, ',' ORDER BY category, line) AS lines,
				STRING_AGG(DISTINCT category, ',' ORDER BY category) AS categories
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

	let where: SQL | undefined = and(
		eq(journeyRuns.line, line),
		COLLECTED_TRAFFIC,
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
			delayed: runDelayedCorrelatedSql.as("delayed"),
		})
		.from(journeyRuns)
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
		COLLECTED_TRAFFIC,
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
	const rows = await db
		.select({
			date: journeyRuns.dayOfOperation,
			total: count().as("total"),
			cancelled:
				sql<number>`SUM(CASE WHEN ${journeyRuns.cancelled} THEN 1 ELSE 0 END)`.as(
					"cancelled",
				),
			ghost: sql<number>`SUM(${ghostCaseSql})`.as("ghost"),
			delayed: runDelayedCorrelatedSql.as("delayed"),
		})
		.from(journeyRuns)
		.where(and(eq(journeyRuns.operator, operator), COLLECTED_TRAFFIC))
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
			.where(and(eq(journeyRuns.operator, operator), COLLECTED_TRAFFIC))
			.orderBy(normalizedCategorySql, journeyRuns.line),
		db
			.selectDistinct({ category: normalizedCategorySql.as("category") })
			.from(journeyRuns)
			.where(
				and(
					eq(journeyRuns.operator, operator),
					isNotNull(journeyRuns.category),
					COLLECTED_TRAFFIC,
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
				COLLECTED_TRAFFIC,
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

/** Per-day history for one stop. Deliberately unwindowed — the station page
 * charts every day it has, so a 30-day bound would drop rows users can see.
 *
 * The join costs ~35 ms at 1.9M stop visits regardless of how the category
 * filter is written; the planner reads `<> 'Fernverkehr'` as unselective
 * (it now matches every row) and picks a parallel seq scan over the runs.
 * Left as is: the route memoizes this for 60 s, so it is paid once per
 * stop per minute, not per request. */
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
			.where(and(inArray(journeyStops.stopId, stopIds), COLLECTED_TRAFFIC))
			.groupBy(journeyStops.dayOfOperation)
			.orderBy(desc(journeyStops.dayOfOperation)),
		db
			.select({
				lastChange: sql<string | null>`MAX(${journeyRuns.snapshotAt})`.as(
					"last_change",
				),
				categories:
					sql<string>`STRING_AGG(DISTINCT ${normalizedCategorySql}, ',' ORDER BY ${normalizedCategorySql})`.as(
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
			.where(and(inArray(journeyStops.stopId, stopIds), COLLECTED_TRAFFIC)),
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
	/** Identity of the stop visit: the journey_stops primary key minus the
	 * day, which every row in one response already shares. Lets the UI key
	 * rows on real data instead of the array index. */
	journeyRef: string;
	routeIdx: number;
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
			journeyRef: journeyStops.journeyRef,
			routeIdx: journeyStops.routeIdx,
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
				COLLECTED_TRAFFIC,
			),
		)
		.orderBy(asc(sql`time`), asc(journeyRuns.line));

	return rows.map((r) => ({
		journeyRef: r.journeyRef,
		routeIdx: r.routeIdx,
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

/** Stop names served in the last 30 days, deduped case-insensitively.
 * Intended for client-side fuzzy search in the subscribe modal — heavy cache
 * at the HTTP layer.
 *
 * Names come from the known_stops rollup, which holds one row per stop id,
 * rather than from grouping the 1.9M-row journey_stops table: 14 ms against
 * 224 ms. The EXISTS keeps the 30-day window, because the rollup itself
 * never expires an entry — without it the picker would slowly fill with
 * stops that stopped running. */
export async function getAllStopNames(): Promise<StopPickerEntry[]> {
	const rows = await db
		.select({
			name: sql<string>`MIN(${knownStops.stopName})`.as("name"),
		})
		.from(knownStops)
		.where(
			// EXISTS over the run join rather than a plain visit check: a stop
			// reachable only by long-distance traffic must not enter the picker
			// if that traffic ever comes back.
			sql`EXISTS (
				SELECT 1 FROM ${journeyStops}
				JOIN ${journeyRuns}
					ON ${journeyRuns.journeyRef} = ${journeyStops.journeyRef}
					AND ${journeyRuns.dayOfOperation} = ${journeyStops.dayOfOperation}
				WHERE ${journeyStops.stopId} = ${knownStops.stopId}
					AND ${journeyStops.dayOfOperation} >= ${sinceDays(30)}
					AND ${COLLECTED_TRAFFIC}
			)`,
		)
		.groupBy(sql`LOWER(${knownStops.stopName})`)
		.orderBy(sql`MIN(${knownStops.stopName})`);
	return rows.map((r) => ({ name: r.name })).filter((r) => r.name);
}

/** Line codes active in the last 30 days. The window matches the other
 * picklists: without it this scanned every row ever ingested, and the modal
 * offered lines that stopped running months ago. */
export async function getAllLineNames(): Promise<string[]> {
	const rows = await db
		.selectDistinct({
			line: journeyRuns.line,
			category: normalizedCategorySql.as("category"),
			source: sourceSql.as("source"),
		})
		.from(journeyRuns)
		.where(and(isNotNull(journeyRuns.line), COLLECTED_TRAFFIC, last30DaysSql()))
		.orderBy(normalizedCategorySql, journeyRuns.line);
	return rows
		.map((r) => lineSlug(r.source, r.category, r.line))
		.filter(Boolean);
}

/** Destinations served in the last 30 days. Windowed for the same reason
 * as getAllLineNames. */
export async function getAllDirections(): Promise<string[]> {
	const rows = await db
		.selectDistinct({ dest: journeyRuns.destName })
		.from(journeyRuns)
		.where(
			and(isNotNull(journeyRuns.destName), COLLECTED_TRAFFIC, last30DaysSql()),
		)
		.orderBy(journeyRuns.destName);
	return rows.map((r) => r.dest).filter(Boolean);
}

/** All distinct destinations a given line has run to in the last 30 days. */
export async function getDirectionsForLine(slug: string): Promise<string[]> {
	const { line, category } = parseLineSlug(slug);
	const where = and(
		eq(journeyRuns.line, line),
		COLLECTED_TRAFFIC,
		category ? eq(normalizedCategorySql, category) : undefined,
	);

	const rows = await db
		.selectDistinct({ dest: journeyRuns.destName })
		.from(journeyRuns)
		.where(
			and(
				where,
				isNotNull(journeyRuns.destName),
				gte(journeyRuns.dayOfOperation, sinceDays(30)),
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
		COLLECTED_TRAFFIC,
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
		.where(and(where, gte(journeyStops.dayOfOperation, sinceDays(30))))
		.orderBy(journeyStops.stopName);
	return rows.map((r) => r.name).filter(Boolean);
}

function dedupeCsv(s: string): string[] {
	return [...new Set(s.split(","))].filter(Boolean);
}

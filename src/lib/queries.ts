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
import { lineSlugSql, sourceSql } from "../db/helpers.ts";
import {
	journeyRuns,
	journeyStops,
	knownStops,
	stopDayStats,
} from "../db/schema.ts";
import {
	DELAY_THRESHOLD_MIN,
	lineSlug,
	parseLineSlug,
	todayBerlin,
} from "./utils.ts";

const ghostCaseSql = sql<number>`CASE WHEN NOT ${journeyRuns.wasTracked} AND NOT ${journeyRuns.cancelled} THEN 1 ELSE 0 END`;

/** Realtime departure time at a run's origin. Correlated rather than
 * joined: the entity day lists read one stop per run, which the
 * (run_id, route_idx) primary key answers as an index probe.
 *
 * The run id is spelled table-qualified because drizzle renders a bare
 * column reference, which a correlated subquery resolves against the
 * inner table. */
const originRtDepTimeSql = sql<string | null>`(
				SELECT js.rt_dep_time FROM journey_stops js
				WHERE js.run_id = "journey_runs"."run_id"
				AND js.route_idx = 0
			)`;

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
 * they summarize. */
const COLLECTED_TRAFFIC = sql`${normalizedCategorySql} <> 'Fernverkehr'
	AND (${journeyRuns.operator} IS NULL OR ${journeyRuns.operator} <> 'Mainzer Mobilität')
	AND (${journeyRuns.pollState} IS NULL OR ${journeyRuns.pollState} <> 'excluded')`;

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
		.selectDistinct({ runId: journeyStops.runId })
		.from(journeyStops)
		.where(where)
		.as("dbr");
}

/** One column, not two: run_id is unique on journey_runs, so it identifies
 * the run on its own. The pair this replaced had to carry day_of_operation
 * because journey_ref was only unique per day. */
function delayedJoinCondition(dbr: ReturnType<typeof delayedByRunSq>) {
	return eq(dbr.runId, journeyRuns.runId);
}

function runDelayedSql(dbr: ReturnType<typeof delayedByRunSq>) {
	return sql<number>`SUM(CASE WHEN NOT ${journeyRuns.cancelled} AND ${dbr.runId} IS NOT NULL THEN 1 ELSE 0 END)`;
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
	WHERE ${journeyStops.runId} = "journey_runs"."run_id"
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

/** Per-stop totals and line lists for the last 7 days, read entirely from
 * the stop_day_stats rollup.
 *
 * Both halves used to be separate: counts from the rollup, line lists from
 * journey_stops JOIN journey_runs. That join was the single most expensive
 * query behind the home page — it sorted ~493k stop visits down to ~2.6k
 * distinct (stop, source:category:line) tuples and spilled to disk at the
 * default 4 MB work_mem, 276 ms against 3.9 ms for the same answer here.
 *
 * Rewriting the join did not help: pre-deduping the runs side measured
 * worse (500 ms), GROUP BY for DISTINCT was a wash, and a larger work_mem
 * made the planner pick a slower plan. The scan was the cost, not the sort,
 * so the fix is to not run it — the poller already visits exactly these
 * rows and can aggregate them on write.
 *
 * Takes no filter: the window is fixed at 7 days, so every caller gets the
 * same answer and it is memoized once rather than per day-filter. */
/** Whether stop_day_stats.lines exists yet, checked once and cached.
 *
 * A column that is not there yet fails the statement at parse time, so this
 * cannot be guarded inside the SQL — the query has to be built differently.
 * The migration that adds the column waits for its lock like anything else,
 * so a build can legitimately be serving before it lands, and the home page
 * has to work in both states rather than 500 until the DDL wins its race.
 *
 * Cached because it only ever goes false -> true, and re-reading the catalog
 * on every home render to learn a fact that changes once is waste. A process
 * that starts before the migration keeps rendering stops without their line
 * chips until it restarts; that is a missing detail, not a broken page. */
let hasLinesColumn: boolean | undefined;

async function linesColumnExists(): Promise<boolean> {
	if (hasLinesColumn === undefined) {
		const [row] = await db.execute<{ present: boolean }>(sql`
			SELECT EXISTS (
				SELECT 1 FROM information_schema.columns
				WHERE table_name = 'stop_day_stats' AND column_name = 'lines'
			) AS present
		`);
		hasLinesColumn = row?.present === true;
	}
	return hasLinesColumn;
}

export async function getStopSummaries(): Promise<StopSummary[]> {
	const withLines = await linesColumnExists();
	const rows = await db
		.select({
			stopId: stopDayStats.stopId,
			stopName: sql<string>`MIN(${stopDayStats.stopName})`.as("stop_name"),
			journeyCount: sql<number>`SUM(${stopDayStats.total})`.as("journey_count"),
			cancelled: sql<number>`SUM(${stopDayStats.cancelled})`.as("cancelled"),
			ghost: sql<number>`SUM(${stopDayStats.ghost})`.as("ghost"),
			delayed: sql<number>`SUM(${stopDayStats.delayed})`.as("delayed"),
			lines: (withLines
				? sql<string | null>`STRING_AGG(${stopDayStats.lines}, ',')`
				: sql<string | null>`NULL::text`
			).as("lines"),
			categories: sql<
				string | null
			>`STRING_AGG(${stopDayStats.categories}, ',')`.as("categories"),
		})
		.from(stopDayStats)
		.where(sql`${stopDayStats.dayOfOperation} >= ${sinceDays(7)}`)
		.groupBy(stopDayStats.stopId)
		.orderBy(desc(sql`SUM(${stopDayStats.total})`));

	return rows.map((r) => ({
		stopIds: [r.stopId],
		stopName: r.stopName,
		journeyCount: Number(r.journeyCount ?? 0),
		cancelled: Number(r.cancelled ?? 0),
		ghost: Number(r.ghost ?? 0),
		delayed: Number(r.delayed ?? 0),
		// Per-day lists concatenated across the window, so a line seen on
		// six days arrives six times.
		lines: r.lines ? dedupeCsv(r.lines) : [],
		categories: r.categories ? dedupeCsv(r.categories) : [],
	}));
}

// ─── Per-day stats, shared by the line, operator and stop pages ────────

/** One day of an entity's record. All three entity pages chart the same
 * five figures from the same row shape. */
export interface DayStats {
	date: string;
	total: number;
	cancelled: number;
	ghost: number;
	delayed: number;
}

/** Postgres returns SUM()/COUNT() as strings over the wire, so every
 * aggregate needs coercing before the charts do arithmetic on it. */
function toDayStats(d: {
	date: string;
	total: unknown;
	cancelled: unknown;
	ghost: unknown;
	delayed: unknown;
}): DayStats {
	return {
		date: d.date,
		total: Number(d.total),
		cancelled: Number(d.cancelled),
		ghost: Number(d.ghost),
		delayed: Number(d.delayed),
	};
}

// ─── Line stats + day journeys ─────────────────────────────────────────

/** The `journey_runs` predicate for one line slug.
 *
 * Spelled once because the line page, its day lists and the picker lists
 * all have to mean the same runs by "this line" — a filter that dropped
 * the source or the category would answer for a wider set than the page
 * it was reached from. */
function lineFilter(slug: string): SQL | undefined {
	const { line, category, source } = parseLineSlug(slug);
	let where: SQL | undefined = and(
		eq(journeyRuns.line, line),
		COLLECTED_TRAFFIC,
	);
	if (category) where = and(where, eq(normalizedCategorySql, category));
	if (source) where = and(where, eq(sourceSql, source));
	return where;
}

export interface LineStats {
	days: DayStats[];
	operators: string[];
	categories: string[];
	destinations: string[];
}

/** Per-day stats for one line, ad-hoc from journey_runs. */
export async function getLineStats(slug: string): Promise<LineStats> {
	const where = lineFilter(slug);

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
		days: rows.map(toDayStats),
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
	const where = and(lineFilter(slug), eq(journeyRuns.dayOfOperation, date));

	const rows = await db
		.select({
			journeyRef: journeyRuns.journeyRef,
			date: journeyRuns.dayOfOperation,
			time: journeyRuns.originDepTime,
			rtTime: originRtDepTimeSql.as("rt_time"),
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

export interface OperatorStats {
	days: DayStats[];
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
		days: rows.map(toDayStats),
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
			rtTime: originRtDepTimeSql.as("rt_time"),
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
/** Per-day stats for one stop, read from the stop_day_stats rollup.
 *
 * This used to aggregate journey_stops joined to journey_runs across the
 * stop's entire history on every cache miss — ~390k stop-visit rows against
 * 1.25M runs at prod scale, with the hash join spilling to disk, which is
 * what made an uncached stop page cost seconds. The rollup answers the same
 * question with one row per stop-day.
 *
 * Full history is preserved: the rollup is written for every day, and
 * getStopDayDepartures still reads the raw rows for per-departure detail. */
export async function getStopStats(stopIds: string[]): Promise<StopStats> {
	if (stopIds.length === 0) {
		return { days: [], lastChange: null, categories: [] };
	}

	// Several stop ids can share one platform group, so a day can appear
	// once per id and the counts have to be summed back together.
	const rows = await db
		.select({
			date: stopDayStats.dayOfOperation,
			total: sql<number>`SUM(${stopDayStats.total})`.as("total"),
			cancelled: sql<number>`SUM(${stopDayStats.cancelled})`.as("cancelled"),
			ghost: sql<number>`SUM(${stopDayStats.ghost})`.as("ghost"),
			delayed: sql<number>`SUM(${stopDayStats.delayed})`.as("delayed"),
			lastChange: sql<string | null>`MAX(${stopDayStats.lastChange})`.as(
				"last_change",
			),
			categories: sql<
				string | null
			>`STRING_AGG(${stopDayStats.categories}, ',')`.as("categories"),
		})
		.from(stopDayStats)
		.where(inArray(stopDayStats.stopId, stopIds))
		.groupBy(stopDayStats.dayOfOperation)
		.orderBy(desc(stopDayStats.dayOfOperation));

	let lastChange: string | null = null;
	const categories: string[] = [];
	for (const r of rows) {
		if (r.lastChange && (!lastChange || r.lastChange > lastChange)) {
			lastChange = r.lastChange;
		}
		if (r.categories) categories.push(r.categories);
	}

	return {
		days: rows.map(toDayStats),
		lastChange,
		categories: categories.length ? dedupeCsv(categories.join(",")) : [],
	};
}

export interface StopDayDeparture {
	/** Identity of the stop visit, as (run, route_idx). Lets the UI key rows
	 * on real data instead of the array index.
	 *
	 * Read from journey_runs now that journey_stops holds run_id rather than
	 * the ref itself. The value is unchanged, so links and React keys built
	 * on it behave exactly as before. */
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
			journeyRef: journeyRuns.journeyRef,
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
		.innerJoin(journeyRuns, eq(journeyRuns.runId, journeyStops.runId))
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

/**
 * Condition matching `known_stops` that had collected traffic in the last `days` days.
 *
 * Built on `stop_day_stats` instead of a correlated EXISTS across `journey_stops`
 * joined with `journey_runs`. This substitution is sound because `refreshStopDayStats`
 * in `src/lib/poll.ts` populates `stop_day_stats` using the exact same three
 * `COLLECTED_TRAFFIC` filters (categoryNorm <> 'Fernverkehr', operator <> 'Mainzer Mobilität',
 * and pollState <> 'excluded'), and explicitly deletes rollup rows for stop-days that
 * end up with zero matching visits. A stop reachable only by long-distance traffic
 * never enters `stop_day_stats`.
 */
function hasCollectedTrafficInDays(days = 30) {
	return inArray(
		knownStops.stopId,
		db
			.select({ stopId: stopDayStats.stopId })
			.from(stopDayStats)
			.where(gte(stopDayStats.dayOfOperation, sinceDays(days))),
	);
}

/** Stop names served in the last 30 days, deduped case-insensitively.
 * Intended for client-side fuzzy search in the subscribe modal — heavy cache
 * at the HTTP layer.
 *
 * Names come from the known_stops rollup, which holds one row per stop id,
 * rather than from grouping the 1.9M-row journey_stops table: 14 ms against
 * 224 ms. The 30-day window filter on stop_day_stats keeps the picker from
 * slowly filling with stops that stopped running, and excludes stops reachable
 * only by long-distance traffic. */
export async function getAllStopNames(): Promise<StopPickerEntry[]> {
	const rows = await db
		.select({
			name: sql<string>`MIN(${knownStops.stopName})`.as("name"),
		})
		.from(knownStops)
		.where(hasCollectedTrafficInDays(30))
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

/** All distinct destinations a line has run to in the last `days` days.
 *
 * The window is a parameter because the Telegram bot matches what a user
 * typed against these: a destination the line stopped serving weeks ago
 * is a wrong answer there, while the picker wants the wider list. */
export async function getDirectionsForLine(
	slug: string,
	days = 30,
): Promise<string[]> {
	const where = lineFilter(slug);

	const rows = await db
		.selectDistinct({ dest: journeyRuns.destName })
		.from(journeyRuns)
		.where(
			and(
				where,
				isNotNull(journeyRuns.destName),
				gte(journeyRuns.dayOfOperation, sinceDays(days)),
			),
		)
		.orderBy(journeyRuns.destName);
	return rows.map((r) => r.dest).filter(Boolean);
}

/** All distinct stop names served by a line in the last 30 days. */
export async function getStopsForLine(slug: string): Promise<string[]> {
	const where = lineFilter(slug);

	const rows = await db
		.selectDistinct({
			name: journeyStops.stopName,
		})
		.from(journeyStops)
		.innerJoin(journeyRuns, eq(journeyRuns.runId, journeyStops.runId))
		.where(and(where, gte(journeyStops.dayOfOperation, sinceDays(30))))
		.orderBy(journeyStops.stopName);
	return rows.map((r) => r.name).filter(Boolean);
}

export interface SitemapEntities {
	stations: string[];
	lines: string[];
	operators: string[];
}

/** Every entity that has a page worth crawling: the routing slug for each,
 * windowed to the last 30 days so the sitemap never advertises a stop or
 * line whose page would render "no data yet".
 *
 * Station slugs come from the `known_stops` rollup, which materializes what
 * `slugForStop` produces on write — deriving them here would duplicate the
 * transliteration and could drift from what `findStopBySlug` resolves. */
export async function getSitemapEntities(): Promise<SitemapEntities> {
	const [stationRows, lineSlugs, operatorRows] = await Promise.all([
		db
			.selectDistinct({ slug: knownStops.slug })
			.from(knownStops)
			.where(and(isNotNull(knownStops.slug), hasCollectedTrafficInDays(30)))
			.orderBy(knownStops.slug),
		getAllLineNames(),
		db
			.selectDistinct({ operator: journeyRuns.operator })
			.from(journeyRuns)
			.where(
				and(
					isNotNull(journeyRuns.operator),
					ne(journeyRuns.operator, ""),
					COLLECTED_TRAFFIC,
					last30DaysSql(),
				),
			)
			.orderBy(journeyRuns.operator),
	]);

	return {
		stations: stationRows.map((r) => r.slug).filter((s): s is string => !!s),
		lines: lineSlugs,
		operators: operatorRows
			.map((r) => r.operator)
			.filter((o): o is string => !!o),
	};
}

function dedupeCsv(s: string): string[] {
	return [...new Set(s.split(","))].filter(Boolean);
}

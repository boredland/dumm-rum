import { and, count, eq, isNotNull, sql } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { excluded } from "../db/helpers.ts";
import {
	journeyRuns,
	journeyStops,
	knownStops,
	lineDailyStats,
	operatorDailyStats,
} from "../db/schema.ts";
import { nameToSlug } from "./stations.ts";
import { DELAY_THRESHOLD_MIN, PLANNED_FREQUENCY_MIN } from "./utils.ts";

// Ghost = scheduled trip that ran without ever receiving realtime data.
// Per RMV, absence of realtime is a strong signal the service didn't run.
const ghostCaseSql = sql<number>`CASE WHEN NOT ${journeyRuns.wasTracked} AND NOT ${journeyRuns.cancelled} THEN 1 ELSE 0 END`;

// Minutes between scheduled and realtime departure at a stop.
// Stored as text HH:MM:SS with a day_of_operation text date — cast to
// timestamp and subtract. EXTRACT(EPOCH FROM ...) gives seconds, / 60 for minutes.
const stopDelayMinSql = sql<number>`
	EXTRACT(EPOCH FROM (
		(${journeyStops.dayOfOperation} || ' ' || ${journeyStops.rtDepTime})::timestamp
		- (${journeyStops.dayOfOperation} || ' ' || ${journeyStops.depTime})::timestamp
	)) / 60.0
`;

const delayedExistsSql = sql<number>`
	CASE WHEN NOT ${journeyRuns.cancelled} AND EXISTS (
		SELECT 1 FROM journey_stops js
		WHERE js.journey_ref = ${journeyRuns.journeyRef}
		AND js.day_of_operation = ${journeyRuns.dayOfOperation}
		AND js.rt_dep_time IS NOT NULL AND js.dep_time IS NOT NULL
		AND EXTRACT(EPOCH FROM (
			(js.day_of_operation || ' ' || js.rt_dep_time)::timestamp
			- (js.day_of_operation || ' ' || js.dep_time)::timestamp
		)) / 60.0 >= ${DELAY_THRESHOLD_MIN}
	) THEN 1 ELSE 0 END
`;

// Per-run avg delay — uses the origin stop (route_idx=0) as the delay
// signal. Cancelled runs contribute PLANNED_FREQUENCY_MIN so a 100%-cancelled
// day still produces a meaningful average instead of NaN.
const runAvgDelaySql = sql<number | null>`
	CASE WHEN ${journeyRuns.cancelled} THEN ${PLANNED_FREQUENCY_MIN} ELSE (
		SELECT EXTRACT(EPOCH FROM (
			(js.day_of_operation || ' ' || js.rt_dep_time)::timestamp
			- (js.day_of_operation || ' ' || js.dep_time)::timestamp
		)) / 60.0
		FROM journey_stops js
		WHERE js.journey_ref = ${journeyRuns.journeyRef}
		AND js.day_of_operation = ${journeyRuns.dayOfOperation}
		AND js.rt_dep_time IS NOT NULL AND js.dep_time IS NOT NULL
		AND js.route_idx = 0
	) END
`;

const stopDelayedExistsSql = sql<number>`
	CASE WHEN NOT ${journeyStops.cancelled}
		AND ${journeyStops.rtDepTime} IS NOT NULL
		AND ${journeyStops.depTime} IS NOT NULL
		AND ${stopDelayMinSql} >= ${DELAY_THRESHOLD_MIN}
	THEN 1 ELSE 0 END
`;

export async function materializeOperatorStats(
	db: Db,
	date: string,
): Promise<void> {
	const rows = await db
		.select({
			operator: journeyRuns.operator,
			total: count().as("total"),
			cancelled:
				sql<number>`SUM(CASE WHEN ${journeyRuns.cancelled} THEN 1 ELSE 0 END)`.as(
					"cancelled",
				),
			ghost: sql<number>`SUM(${ghostCaseSql})`.as("ghost"),
			delayed: sql<number>`SUM(${delayedExistsSql})`.as("delayed"),
			avgDelay: sql<number | null>`AVG(${runAvgDelaySql})`.as("avg_delay"),
		})
		.from(journeyRuns)
		.where(
			and(
				eq(journeyRuns.dayOfOperation, date),
				isNotNull(journeyRuns.operator),
			),
		)
		.groupBy(journeyRuns.operator);

	if (rows.length === 0) return;

	await db
		.insert(operatorDailyStats)
		.values(
			rows.map((r) => ({
				// operator is filtered non-null in the WHERE; the cast is safe here.
				operator: r.operator as string,
				date,
				total: Number(r.total),
				cancelled: Number(r.cancelled),
				ghost: Number(r.ghost),
				delayed: Number(r.delayed),
				avgDelay: r.avgDelay,
			})),
		)
		.onConflictDoUpdate({
			target: [operatorDailyStats.operator, operatorDailyStats.date],
			set: {
				total: excluded(operatorDailyStats.total),
				cancelled: excluded(operatorDailyStats.cancelled),
				ghost: excluded(operatorDailyStats.ghost),
				delayed: excluded(operatorDailyStats.delayed),
				avgDelay: excluded(operatorDailyStats.avgDelay),
			},
		});
}

export async function materializeLineStats(
	db: Db,
	date: string,
): Promise<void> {
	const rows = await db
		.select({
			line: journeyRuns.line,
			category: sql<string | null>`MAX(${journeyRuns.category})`.as("category"),
			total: count().as("total"),
			cancelled:
				sql<number>`SUM(CASE WHEN ${journeyRuns.cancelled} THEN 1 ELSE 0 END)`.as(
					"cancelled",
				),
			ghost: sql<number>`SUM(${ghostCaseSql})`.as("ghost"),
			delayed: sql<number>`SUM(${delayedExistsSql})`.as("delayed"),
			avgDelay: sql<number | null>`AVG(${runAvgDelaySql})`.as("avg_delay"),
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
		.where(eq(journeyRuns.dayOfOperation, date))
		.groupBy(journeyRuns.line);

	if (rows.length === 0) return;

	await db
		.insert(lineDailyStats)
		.values(
			rows.map((r) => ({
				line: r.line,
				date,
				total: Number(r.total),
				cancelled: Number(r.cancelled),
				ghost: Number(r.ghost),
				delayed: Number(r.delayed),
				avgDelay: r.avgDelay,
				category: r.category,
				operators: r.operators,
				destinations: r.destinations,
			})),
		)
		.onConflictDoUpdate({
			target: [lineDailyStats.line, lineDailyStats.date],
			set: {
				total: excluded(lineDailyStats.total),
				cancelled: excluded(lineDailyStats.cancelled),
				ghost: excluded(lineDailyStats.ghost),
				delayed: excluded(lineDailyStats.delayed),
				avgDelay: excluded(lineDailyStats.avgDelay),
				category: excluded(lineDailyStats.category),
				operators: excluded(lineDailyStats.operators),
				destinations: excluded(lineDailyStats.destinations),
			},
		});
}

/**
 * Rebuild the `known_stops` rollup from the last 7 days of journey_stops +
 * journey_runs. One row per stop_id with denormalized line/category lists
 * and coarse counts, so the UI's stops list renders without a fan-out query.
 */
export async function materializeKnownStops(db: Db): Promise<void> {
	const rows = await db
		.select({
			stopId: journeyStops.stopId,
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
			delayed: sql<number>`SUM(${stopDelayedExistsSql})`.as("delayed"),
			lines: sql<string>`STRING_AGG(DISTINCT ${journeyRuns.line}, ',')`.as(
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
			sql`${journeyStops.dayOfOperation} >= to_char(CURRENT_DATE - INTERVAL '7 days', 'YYYY-MM-DD')`,
		)
		.groupBy(journeyStops.stopId);

	if (rows.length === 0) return;

	const now = new Date().toISOString();
	await db
		.insert(knownStops)
		.values(
			rows.map((r) => ({
				stopId: r.stopId,
				stopName: r.stopName,
				slug: nameToSlug(r.stopName),
				lines: r.lines,
				categories: r.categories,
				journeyCount: Number(r.journeyCount),
				cancelled: Number(r.cancelled),
				ghost: Number(r.ghost),
				delayed: Number(r.delayed),
				updatedAt: now,
			})),
		)
		.onConflictDoUpdate({
			target: knownStops.stopId,
			set: {
				stopName: excluded(knownStops.stopName),
				slug: excluded(knownStops.slug),
				lines: excluded(knownStops.lines),
				categories: excluded(knownStops.categories),
				journeyCount: excluded(knownStops.journeyCount),
				cancelled: excluded(knownStops.cancelled),
				ghost: excluded(knownStops.ghost),
				delayed: excluded(knownStops.delayed),
				updatedAt: excluded(knownStops.updatedAt),
			},
		});
}

export async function materializeAllForToday(
	db: Db,
	today: string,
): Promise<void> {
	await Promise.all([
		materializeOperatorStats(db, today),
		materializeLineStats(db, today),
		materializeKnownStops(db),
	]);
}

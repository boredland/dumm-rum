import { env } from "cloudflare:workers";
import type { APIRoute } from "astro";
import { and, eq, gte, sql } from "drizzle-orm";
import { createDb } from "../../db/client";
import { journeyPositions, journeyRuns, journeyStops } from "../../db/schema";
import { nowBerlin, todayBerlin } from "../../lib/utils";

export const GET: APIRoute = async () => {
	const db = createDb(env.DB);
	const today = todayBerlin();
	const cutoff = new Date(Date.now() - 15 * 60 * 1000).toISOString();
	const nowTime = nowBerlin().format("HH:mm:ss");

	const nextStop = db.$with("next_stop").as(
		db
			.select({
				journeyRef: journeyStops.journeyRef,
				dayOfOperation: journeyStops.dayOfOperation,
				lat: journeyStops.lat,
				lon: journeyStops.lon,
				arrTime:
					sql<string>`COALESCE(${journeyStops.rtArrTime}, ${journeyStops.arrTime}, ${journeyStops.depTime})`.as(
						"arr_time_resolved",
					),
				routeIdx: sql<number>`MIN(${journeyStops.routeIdx})`.as("min_idx"),
			})
			.from(journeyStops)
			.where(
				and(
					eq(journeyStops.dayOfOperation, today),
					eq(journeyStops.cancelled, 0),
					sql`${journeyStops.depTime} > ${nowTime}`,
					sql`${journeyStops.lat} IS NOT NULL`,
				),
			)
			.groupBy(journeyStops.journeyRef, journeyStops.dayOfOperation),
	);

	const lastStop = db.$with("last_stop").as(
		db
			.select({
				journeyRef: journeyStops.journeyRef,
				dayOfOperation: journeyStops.dayOfOperation,
				depTime:
					sql<string>`COALESCE(${journeyStops.rtDepTime}, ${journeyStops.depTime})`.as(
						"dep_time_resolved",
					),
				routeIdx: sql<number>`MAX(${journeyStops.routeIdx})`.as("max_idx"),
			})
			.from(journeyStops)
			.where(
				and(
					eq(journeyStops.dayOfOperation, today),
					eq(journeyStops.cancelled, 0),
					sql`${journeyStops.depTime} <= ${nowTime}`,
				),
			)
			.groupBy(journeyStops.journeyRef, journeyStops.dayOfOperation),
	);

	const vehicles = await db
		.with(nextStop, lastStop)
		.select({
			id: journeyRuns.journeyRef,
			line: journeyRuns.line,
			category: journeyRuns.category,
			operator: journeyRuns.operator,
			origin: journeyRuns.originName,
			destination: journeyRuns.destName,
			lat: journeyPositions.lat,
			lon: journeyPositions.lon,
			reportedAt: journeyPositions.reportedAt,
			routeIdx: journeyPositions.routeIdx,
			destArrTime: journeyRuns.destArrTime,
			polyline: journeyRuns.polyline,
			nextLat: nextStop.lat,
			nextLon: nextStop.lon,
			lastDepTime: lastStop.depTime,
			nextArrTime: nextStop.arrTime,
		})
		.from(journeyRuns)
		.innerJoin(
			journeyPositions,
			and(
				eq(journeyPositions.journeyRef, journeyRuns.journeyRef),
				eq(journeyPositions.dayOfOperation, journeyRuns.dayOfOperation),
			),
		)
		.leftJoin(
			nextStop,
			and(
				eq(nextStop.journeyRef, journeyRuns.journeyRef),
				eq(nextStop.dayOfOperation, journeyRuns.dayOfOperation),
			),
		)
		.leftJoin(
			lastStop,
			and(
				eq(lastStop.journeyRef, journeyRuns.journeyRef),
				eq(lastStop.dayOfOperation, journeyRuns.dayOfOperation),
			),
		)
		.where(
			and(
				eq(journeyRuns.dayOfOperation, today),
				eq(journeyRuns.pollState, "polling"),
				eq(journeyRuns.cancelled, 0),
				eq(
					journeyPositions.id,
					sql`(SELECT jp2.id FROM journey_positions jp2 WHERE jp2.journey_ref = ${journeyRuns.journeyRef} AND jp2.day_of_operation = ${journeyRuns.dayOfOperation} ORDER BY jp2.captured_at DESC LIMIT 1)`,
				),
				gte(journeyPositions.capturedAt, cutoff),
				sql`${journeyRuns.destArrTime} >= ${nowTime}`,
			),
		);

	return Response.json(
		{ vehicles, updatedAt: new Date().toISOString() },
		{
			headers: {
				"Cache-Control": "s-maxage=30, stale-while-revalidate=30",
			},
		},
	);
};

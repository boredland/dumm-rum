import { env } from "cloudflare:workers";
import type { APIRoute } from "astro";
import { and, eq, gte, sql } from "drizzle-orm";
import { createDb } from "../../db/client";
import { journeyPositions, journeyRuns } from "../../db/schema";
import { nowBerlin, todayBerlin } from "../../lib/utils";

export const GET: APIRoute = async () => {
	const db = createDb(env.DB);
	const today = todayBerlin();
	const cutoff = new Date(Date.now() - 10 * 60 * 1000).toISOString();
	const nowTime = nowBerlin().format("HH:mm:ss");

	const stopsSubquery = sql<string | null>`(
		SELECT json_group_array(json_object(
			'lat', js.lat, 'lon', js.lon,
			'arr', COALESCE(js.rt_arr_time, js.arr_time, js.dep_time),
			'dep', COALESCE(js.rt_dep_time, js.dep_time)
		)) FROM (
			SELECT js.lat, js.lon, js.rt_arr_time, js.arr_time, js.dep_time, js.rt_dep_time
			FROM journey_stops js
			WHERE js.journey_ref = "journey_runs"."journey_ref"
			AND js.day_of_operation = "journey_runs"."day_of_operation"
			AND js.cancelled = 0 AND js.lat IS NOT NULL
			ORDER BY js.route_idx
		) js
	)`;

	const [vehicles, ghosts] = await Promise.all([
		db
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
				destArrTime: journeyRuns.destArrTime,
				originDepTime: journeyRuns.originDepTime,
				polyline: journeyRuns.polyline,
				stops: stopsSubquery.as("stops"),
				ghost: sql<number>`0`.as("ghost"),
			})
			.from(journeyRuns)
			.innerJoin(
				journeyPositions,
				and(
					eq(journeyPositions.journeyRef, journeyRuns.journeyRef),
					eq(journeyPositions.dayOfOperation, journeyRuns.dayOfOperation),
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
					sql`${journeyRuns.originDepTime} <= time(${nowTime}, '+5 minutes')`,
				),
			),
		db
			.select({
				id: journeyRuns.journeyRef,
				line: journeyRuns.line,
				category: journeyRuns.category,
				operator: journeyRuns.operator,
				origin: journeyRuns.originName,
				destination: journeyRuns.destName,
				lat: sql<number>`NULL`.as("lat"),
				lon: sql<number>`NULL`.as("lon"),
				reportedAt: sql<string>`NULL`.as("reported_at"),
				destArrTime: journeyRuns.destArrTime,
				originDepTime: journeyRuns.originDepTime,
				polyline: journeyRuns.polyline,
				stops: stopsSubquery.as("stops"),
				ghost: sql<number>`1`.as("ghost"),
			})
			.from(journeyRuns)
			.where(
				and(
					eq(journeyRuns.dayOfOperation, today),
					eq(journeyRuns.cancelled, 0),
					eq(journeyRuns.wasTracked, 0),
					sql`${journeyRuns.destArrTime} >= ${nowTime}`,
					sql`${journeyRuns.originDepTime} <= ${nowTime}`,
				),
			),
	]);

	return Response.json(
		{ vehicles: [...vehicles, ...ghosts], updatedAt: new Date().toISOString() },
		{
			headers: {
				"Cache-Control": "s-maxage=30, stale-while-revalidate=30",
			},
		},
	);
};

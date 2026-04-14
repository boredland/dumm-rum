import { env } from "cloudflare:workers";
import type { APIRoute } from "astro";
import { and, eq, gte, sql } from "drizzle-orm";
import { createDb } from "../../db/client";
import { journeyPositions, journeyRuns } from "../../db/schema";
import { nowBerlin, todayBerlin } from "../../lib/utils";

export const GET: APIRoute = async () => {
	const db = createDb(env.DB);
	const today = todayBerlin();
	const cutoff = new Date(Date.now() - 15 * 60 * 1000).toISOString();
	const nowTime = nowBerlin().format("HH:mm:ss");

	const vehicles = await db
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
			nextLat: sql<number | null>`(
				SELECT js.lat FROM journey_stops js
				WHERE js.journey_ref = "journey_runs"."journey_ref"
				AND js.day_of_operation = "journey_runs"."day_of_operation"
				AND js.dep_time > ${nowTime}
				AND js.cancelled = 0 AND js.lat IS NOT NULL
				ORDER BY js.route_idx LIMIT 1
			)`.as("next_lat"),
			nextLon: sql<number | null>`(
				SELECT js.lon FROM journey_stops js
				WHERE js.journey_ref = "journey_runs"."journey_ref"
				AND js.day_of_operation = "journey_runs"."day_of_operation"
				AND js.dep_time > ${nowTime}
				AND js.cancelled = 0 AND js.lon IS NOT NULL
				ORDER BY js.route_idx LIMIT 1
			)`.as("next_lon"),
			lastDepTime: sql<string | null>`(
				SELECT COALESCE(js.rt_dep_time, js.dep_time) FROM journey_stops js
				WHERE js.journey_ref = "journey_runs"."journey_ref"
				AND js.day_of_operation = "journey_runs"."day_of_operation"
				AND js.dep_time <= ${nowTime} AND js.cancelled = 0
				ORDER BY js.route_idx DESC LIMIT 1
			)`.as("last_dep_time"),
			nextArrTime: sql<string | null>`(
				SELECT COALESCE(js.rt_arr_time, js.arr_time, js.dep_time) FROM journey_stops js
				WHERE js.journey_ref = "journey_runs"."journey_ref"
				AND js.day_of_operation = "journey_runs"."day_of_operation"
				AND js.dep_time > ${nowTime}
				AND js.cancelled = 0
				ORDER BY js.route_idx LIMIT 1
			)`.as("next_arr_time"),
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

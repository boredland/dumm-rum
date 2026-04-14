import { env } from "cloudflare:workers";
import type { APIRoute } from "astro";
import { and, eq, sql } from "drizzle-orm";
import { createDb } from "../../db/client";
import { journeyPositions, journeyRuns } from "../../db/schema";
import { todayBerlin } from "../../lib/utils";

export const GET: APIRoute = async () => {
	const db = createDb(env.DB);
	const today = todayBerlin();

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

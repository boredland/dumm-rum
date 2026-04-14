import { env } from "cloudflare:workers";
import type { APIRoute } from "astro";
import { and, asc, eq, gte, inArray, isNotNull, sql } from "drizzle-orm";
import { createDb } from "../../db/client";
import { coalesce } from "../../db/helpers";
import { journeyPositions, journeyRuns, journeyStops } from "../../db/schema";
import { nowBerlin, todayBerlin } from "../../lib/utils";

export const GET: APIRoute = async () => {
	const db = createDb(env.DB);
	const today = todayBerlin();
	const cutoff = new Date(Date.now() - 10 * 60 * 1000).toISOString();
	const nowTime = nowBerlin().format("HH:mm:ss");

	const [trackedRows, ghostRows] = await Promise.all([
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
						sql`(SELECT jp2.id FROM journey_positions jp2 WHERE jp2.journey_ref = "journey_runs"."journey_ref" AND jp2.day_of_operation = "journey_runs"."day_of_operation" ORDER BY jp2.captured_at DESC LIMIT 1)`,
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
				destArrTime: journeyRuns.destArrTime,
				originDepTime: journeyRuns.originDepTime,
				polyline: journeyRuns.polyline,
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

	const allIds = [
		...trackedRows.map((v) => v.id),
		...ghostRows.map((v) => v.id),
	];

	const stopRows =
		allIds.length > 0
			? await db
					.select({
						journeyRef: journeyStops.journeyRef,
						lat: journeyStops.lat,
						lon: journeyStops.lon,
						arr: coalesce<string>(
							journeyStops.rtArrTime,
							journeyStops.arrTime,
							journeyStops.depTime,
						),
						dep: coalesce<string>(journeyStops.rtDepTime, journeyStops.depTime),
					})
					.from(journeyStops)
					.where(
						and(
							eq(journeyStops.dayOfOperation, today),
							inArray(journeyStops.journeyRef, allIds),
							eq(journeyStops.cancelled, 0),
							isNotNull(journeyStops.lat),
						),
					)
					.orderBy(journeyStops.journeyRef, asc(journeyStops.routeIdx))
			: [];

	const stopsByJourney = new Map<string, typeof stopRows>();
	for (const s of stopRows) {
		const arr = stopsByJourney.get(s.journeyRef) ?? [];
		arr.push(s);
		stopsByJourney.set(s.journeyRef, arr);
	}

	const vehicles = trackedRows.map((v) => ({
		...v,
		stops: JSON.stringify(
			(stopsByJourney.get(v.id) ?? []).map((s) => ({
				lat: s.lat,
				lon: s.lon,
				arr: s.arr,
				dep: s.dep,
			})),
		),
		ghost: 0,
	}));

	const ghosts = ghostRows.map((v) => ({
		...v,
		lat: null as number | null,
		lon: null as number | null,
		reportedAt: null as string | null,
		stops: JSON.stringify(
			(stopsByJourney.get(v.id) ?? []).map((s) => ({
				lat: s.lat,
				lon: s.lon,
				arr: s.arr,
				dep: s.dep,
			})),
		),
		ghost: 1,
	}));

	return Response.json(
		{ vehicles: [...vehicles, ...ghosts], updatedAt: new Date().toISOString() },
		{
			headers: {
				"Cache-Control": "s-maxage=30, stale-while-revalidate=30",
			},
		},
	);
};

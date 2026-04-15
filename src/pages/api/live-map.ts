import { env } from "cloudflare:workers";
import type { APIRoute } from "astro";
import { and, asc, eq, gte, inArray, isNotNull, sql } from "drizzle-orm";
import { createDb } from "../../db/client";
import { coalesce } from "../../db/helpers";
import { journeyPositions, journeyRuns, journeyStops } from "../../db/schema";
import { nowBerlin } from "../../lib/utils";

export const GET: APIRoute = async () => {
	const db = createDb(env.DB);
	const now = nowBerlin();
	const today = now.format("YYYY-MM-DD");
	const yesterday = now.subtract(1, "day").format("YYYY-MM-DD");
	const cutoff = new Date(Date.now() - 10 * 60 * 1000).toISOString();
	const nowTime = now.format("HH:mm:ss");

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
					inArray(journeyRuns.dayOfOperation, [today, yesterday]),
					eq(journeyRuns.pollState, "polling"),
					eq(journeyRuns.cancelled, 0),
					eq(
						journeyPositions.id,
						sql`(SELECT jp2.id FROM journey_positions jp2 WHERE jp2.journey_ref = "journey_runs"."journey_ref" AND jp2.day_of_operation = "journey_runs"."day_of_operation" ORDER BY jp2.captured_at DESC LIMIT 1)`,
					),
					gte(journeyPositions.capturedAt, cutoff),
					sql`(${journeyRuns.destArrTime} >= ${nowTime} OR ${journeyRuns.destArrTime} = ${journeyRuns.originDepTime})`,
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
					eq(journeyRuns.pollState, "done"),
					sql`(${journeyRuns.destArrTime} >= ${nowTime} OR (${journeyRuns.destArrTime} = ${journeyRuns.originDepTime} AND (${journeyRuns.originDepTime} >= time(${nowTime}, '-1 hour') OR time(${nowTime}, '-1 hour') > ${nowTime})))`,
					sql`${journeyRuns.originDepTime} <= ${nowTime}`,
				),
			),
	]);

	const trackedIds = new Set(trackedRows.map((v) => v.id));
	const ghostIds = ghostRows.map((v) => v.id);

	// Tracked vehicles snap to GPS on the client — only stopCount is needed
	// to filter out malformed entries. Ghosts need full stop coords for
	// schedule-based interpolation.
	const stopCountBatch = 50;
	const stopCountByJourney = new Map<string, number>();
	const trackedIdArr = [...trackedIds];
	for (let i = 0; i < trackedIdArr.length; i += stopCountBatch) {
		const chunk = trackedIdArr.slice(i, i + stopCountBatch);
		const rows = await db
			.select({
				journeyRef: journeyStops.journeyRef,
				n: sql<number>`COUNT(*)`,
			})
			.from(journeyStops)
			.where(
				and(
					inArray(journeyStops.dayOfOperation, [today, yesterday]),
					inArray(journeyStops.journeyRef, chunk),
					eq(journeyStops.cancelled, 0),
					isNotNull(journeyStops.lat),
				),
			)
			.groupBy(journeyStops.journeyRef);
		for (const r of rows) stopCountByJourney.set(r.journeyRef, Number(r.n));
	}

	const ghostStopRows: {
		journeyRef: string;
		lat: number | null;
		lon: number | null;
		arr: string;
		dep: string;
	}[] = [];
	for (let i = 0; i < ghostIds.length; i += stopCountBatch) {
		const chunk = ghostIds.slice(i, i + stopCountBatch);
		const rows = await db
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
					inArray(journeyStops.dayOfOperation, [today, yesterday]),
					inArray(journeyStops.journeyRef, chunk),
					eq(journeyStops.cancelled, 0),
					isNotNull(journeyStops.lat),
				),
			)
			.orderBy(journeyStops.journeyRef, asc(journeyStops.routeIdx));
		ghostStopRows.push(...rows);
	}

	const ghostStopsByJourney = new Map<string, typeof ghostStopRows>();
	for (const s of ghostStopRows) {
		const arr = ghostStopsByJourney.get(s.journeyRef) ?? [];
		arr.push(s);
		ghostStopsByJourney.set(s.journeyRef, arr);
	}

	const vehicles = trackedRows.map((v) => ({
		...v,
		stopCount: stopCountByJourney.get(v.id) ?? 0,
		ghost: 0,
	}));

	const ghosts = ghostRows.map((v) => ({
		...v,
		lat: null as number | null,
		lon: null as number | null,
		reportedAt: null as string | null,
		stops: JSON.stringify(
			(ghostStopsByJourney.get(v.id) ?? []).map((s) => ({
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
				// `max-age=0` keeps the browser from caching across the
				// 30s edge window — which matters when the payload shape
				// changes, since a 4-hour browser cache would otherwise
				// serve a stale shape to clients running newer JS.
				"Cache-Control":
					"public, max-age=0, s-maxage=30, stale-while-revalidate=30",
			},
		},
	);
};

import { env } from "cloudflare:workers";
import type { APIRoute } from "astro";
import {
	and,
	asc,
	eq,
	gte,
	inArray,
	isNotNull,
	notInArray,
	sql,
} from "drizzle-orm";
import { createDb } from "../../db/client";
import { coalesce } from "../../db/helpers";
import { journeyPositions, journeyRuns, journeyStops } from "../../db/schema";
import { nowBerlin } from "../../lib/utils";

// Mirror of the discovery-time EXCLUDE_CATEGORIES in collect.ts. Applied
// here too so any rows that slipped through before the filter existed
// (or through a buggier earlier discovery) don't render.
const EXCLUDE_CATEGORIES = [
	"ICE",
	"ICE-Sprinter",
	"IC",
	"EC",
	"ECE",
	"NJ",
	"EN",
	"RJ",
	"RJX",
	"TGV",
	"FLX",
	"FlixTrain",
	"EST",
];

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
					notInArray(journeyRuns.category, EXCLUDE_CATEGORIES),
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
					notInArray(journeyRuns.category, EXCLUDE_CATEGORIES),
					// Only surface ghosts during the trip's planned run window.
					// Requires an enriched destArrTime (> originDepTime) — runs
					// that still carry the discovery-time placeholder
					// (destArrTime = originDepTime) are skipped; we don't know
					// when those were supposed to end.
					sql`${journeyRuns.destArrTime} > ${journeyRuns.originDepTime}`,
					sql`${journeyRuns.originDepTime} <= ${nowTime}`,
					sql`${journeyRuns.destArrTime} >= ${nowTime}`,
				),
			),
	]);

	const allIds = [
		...trackedRows.map((v) => v.id),
		...ghostRows.map((v) => v.id),
	];

	// Stops are the motion source on the client: GPS gives an accurate
	// anchor every poll, but between polls the marker slides along the
	// scheduled stop sequence so the map doesn't look frozen.
	const BATCH = 50;
	const stopRows: {
		journeyRef: string;
		lat: number | null;
		lon: number | null;
		arr: string;
		dep: string;
	}[] = [];
	for (let i = 0; i < allIds.length; i += BATCH) {
		const chunk = allIds.slice(i, i + BATCH);
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
		stopRows.push(...rows);
	}

	const stopsByJourney = new Map<string, typeof stopRows>();
	for (const s of stopRows) {
		const arr = stopsByJourney.get(s.journeyRef) ?? [];
		arr.push(s);
		stopsByJourney.set(s.journeyRef, arr);
	}

	const serializeStops = (id: string) =>
		JSON.stringify(
			(stopsByJourney.get(id) ?? []).map((s) => ({
				lat: s.lat,
				lon: s.lon,
				arr: s.arr,
				dep: s.dep,
			})),
		);

	const vehicles = trackedRows.map((v) => ({
		...v,
		stops: serializeStops(v.id),
		ghost: 0,
	}));

	const ghosts = ghostRows.map((v) => ({
		...v,
		lat: null as number | null,
		lon: null as number | null,
		reportedAt: null as string | null,
		stops: serializeStops(v.id),
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

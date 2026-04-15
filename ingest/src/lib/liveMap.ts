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
import { db } from "../db/client.ts";
import { coalesce } from "../db/helpers.ts";
import { journeyPositions, journeyRuns, journeyStops } from "../db/schema.ts";
import { nowBerlin } from "./utils.ts";

// Mirror of the discovery-time EXCLUDE_CATEGORIES in discover.ts. Applied
// here too so any rows that slipped through before the filter existed
// don't render on the map.
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

export interface MapStop {
	lat: number | null;
	lon: number | null;
	arr: string | null;
	dep: string | null;
}

export interface MapVehicle {
	id: string;
	line: string;
	category: string | null;
	operator: string | null;
	origin: string;
	destination: string;
	lat: number | null;
	lon: number | null;
	reportedAt: string | null;
	destArrTime: string;
	originDepTime: string;
	polyline: string | null;
	stops: string;
	ghost: 0 | 1;
	/** Delay in minutes vs. the scheduled origin departure. 0 if no rt data yet. */
	delayMin: number;
}

export interface LiveMapPayload {
	vehicles: MapVehicle[];
	updatedAt: string;
}

const STOP_BATCH = 50;
const POS_CUTOFF_MIN = 10;

export async function getLiveMap(): Promise<LiveMapPayload> {
	const now = nowBerlin();
	const today = now.format("YYYY-MM-DD");
	const yesterday = now.subtract(1, "day").format("YYYY-MM-DD");
	const nowTime = now.format("HH:mm:ss");
	const nowPlus5 = now.add(5, "minute").format("HH:mm:ss");
	const cutoff = now.subtract(POS_CUTOFF_MIN, "minute").toISOString();

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
					eq(journeyRuns.cancelled, false),
					notInArray(journeyRuns.category, EXCLUDE_CATEGORIES),
					eq(
						journeyPositions.id,
						sql`(SELECT jp2.id FROM journey_positions jp2 WHERE jp2.journey_ref = ${journeyRuns.journeyRef} AND jp2.day_of_operation = ${journeyRuns.dayOfOperation} ORDER BY jp2.captured_at DESC LIMIT 1)`,
					),
					gte(journeyPositions.capturedAt, cutoff),
					sql`(${journeyRuns.destArrTime} >= ${nowTime} OR ${journeyRuns.destArrTime} = ${journeyRuns.originDepTime})`,
					sql`${journeyRuns.originDepTime} <= ${nowPlus5}`,
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
					eq(journeyRuns.cancelled, false),
					eq(journeyRuns.wasTracked, false),
					eq(journeyRuns.pollState, "done"),
					notInArray(journeyRuns.category, EXCLUDE_CATEGORIES),
					// Only surface ghosts during the trip's planned run window.
					// Skip runs still carrying the discovery-time placeholder
					// (destArrTime = originDepTime) — we don't know their real window.
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
	const stopRows: {
		journeyRef: string;
		lat: number | null;
		lon: number | null;
		arr: string | null;
		dep: string | null;
	}[] = [];
	for (let i = 0; i < allIds.length; i += STOP_BATCH) {
		const chunk = allIds.slice(i, i + STOP_BATCH);
		if (chunk.length === 0) continue;
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
					eq(journeyStops.cancelled, false),
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

	const serializeStops = (id: string): string =>
		JSON.stringify(
			(stopsByJourney.get(id) ?? []).map((s) => ({
				lat: s.lat,
				lon: s.lon,
				arr: s.arr,
				dep: s.dep,
			})),
		);

	// Origin-stop delay: compare rt_dep_time vs scheduled dep_time on route_idx=0.
	// Simpler than picking the nearest-passed stop dynamically, and usually a
	// decent proxy for current delay. Only needed for tracked vehicles.
	const trackedIds = trackedRows.map((v) => v.id);
	const delayByJourney = new Map<string, number>();
	if (trackedIds.length > 0) {
		const delayRows = await db
			.select({
				journeyRef: journeyStops.journeyRef,
				rtDep: journeyStops.rtDepTime,
				dep: journeyStops.depTime,
				dayOfOperation: journeyStops.dayOfOperation,
			})
			.from(journeyStops)
			.where(
				and(
					eq(journeyStops.routeIdx, 0),
					inArray(journeyStops.dayOfOperation, [today, yesterday]),
					inArray(journeyStops.journeyRef, trackedIds),
					isNotNull(journeyStops.rtDepTime),
				),
			);
		for (const r of delayRows) {
			if (!r.rtDep || !r.dep) continue;
			const planned = new Date(`${r.dayOfOperation}T${r.dep}`).getTime();
			const actual = new Date(`${r.dayOfOperation}T${r.rtDep}`).getTime();
			const delayMin = Math.round((actual - planned) / 60_000);
			if (delayMin > 0) delayByJourney.set(r.journeyRef, delayMin);
		}
	}

	const vehicles: MapVehicle[] = trackedRows.map((v) => ({
		...v,
		stops: serializeStops(v.id),
		ghost: 0,
		delayMin: delayByJourney.get(v.id) ?? 0,
	}));

	const ghosts: MapVehicle[] = ghostRows.map((v) => ({
		...v,
		lat: null,
		lon: null,
		reportedAt: null,
		stops: serializeStops(v.id),
		ghost: 1,
		delayMin: 0,
	}));

	return {
		vehicles: [...vehicles, ...ghosts],
		updatedAt: new Date().toISOString(),
	};
}

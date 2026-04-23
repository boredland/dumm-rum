/**
 * KVV poll worker — takes a synthetic `kvv|...` tripRef off the queue,
 * fetches the full stop sequence via EFA `XML_TRIPSTOPTIMES_REQUEST`,
 * and upserts `journey_runs`/`journey_stops` in the same shape our RMV
 * poller does. Re-enqueues at +60 s until the journey's hard arrival
 * cap passes or we hit the poll-count ceiling.
 *
 * Important difference from RMV: EFA doesn't tell us which stop the
 * vehicle has last passed (`lastPassRouteIdx`). So our "mark done"
 * decision is purely time-based — no early exit when the vehicle has
 * obviously arrived. The hard cap (scheduled arrival + duration buffer)
 * keeps us honest.
 */

import { and, eq, sql } from "drizzle-orm";
import type PgBoss from "pg-boss";
import type { Db } from "../db/client.ts";
import { excluded } from "../db/helpers.ts";
import { journeyRuns, journeyStops } from "../db/schema.ts";
import { cacheGet, cachePut } from "./cache.ts";
import { KVV_POLL_QUEUE } from "./kvv-discover.ts";
import {
	decodeTripRef,
	type EfaTripDetail,
	efaTripDetail,
	efaTripShape,
	normalizeEfaCategory,
	shapeCacheKey,
	shapeFromL1,
	shapeToL1,
} from "./kvv-efa.ts";
import { berlinTime, nowBerlin } from "./utils.ts";

export interface KvvPollJob {
	journeyRef: string;
	dayOfOperation: string;
	pollCount: number;
	efaFailCount?: number;
}

/** Transient EFA failures get the same 5-attempt budget the RMV
 * poller gives mgate. Past that we mark the run done rather than
 * burn worker cycles on a dead ref. */
const EFA_MAX_FAIL_COUNT = 5;
const RETRY_DELAY_S = 60;

/** Shapes are stable for the life of a schedule period — the j26
 * project tag in each `stateless` rolls over annually in December. A
 * one-week TTL refreshes opportunistically without letting the cache
 * ossify across timetable rollouts. */
const SHAPE_TTL_MS = 7 * 24 * 60 * 60 * 1_000;

async function markRunDone(
	db: Db,
	journeyRef: string,
	dayOfOperation: string,
): Promise<void> {
	await db
		.update(journeyRuns)
		.set({ pollState: "done" })
		.where(
			and(
				eq(journeyRuns.journeyRef, journeyRef),
				eq(journeyRuns.dayOfOperation, dayOfOperation),
			),
		);
}

interface BatchStats {
	ok: number;
	skipped: number;
	transient: number;
	terminal: number;
	done: number;
}

export async function processKvvPollBatch(
	db: Db,
	boss: PgBoss,
	jobs: PgBoss.Job<KvvPollJob>[],
): Promise<void> {
	const now = new Date().toISOString();
	const stats: BatchStats = {
		ok: 0,
		skipped: 0,
		transient: 0,
		terminal: 0,
		done: 0,
	};

	// EFA is per-trip, not batch. pg-boss delivers jobs in batches of 10
	// via `processKvvPollBatch`; we fan them out in parallel — the EFA
	// server handles concurrent requests fine (Mentz's default is 100+
	// simultaneous sessions) and the only bottleneck is our own jitter.
	const details = await Promise.all(
		jobs.map((j) => efaTripDetail(j.data.journeyRef)),
	);

	for (let i = 0; i < jobs.length; i++) {
		const job = jobs[i];
		const {
			journeyRef,
			dayOfOperation,
			pollCount,
			efaFailCount = 0,
		} = job.data;

		try {
			const [row] = await db
				.select({ pollState: journeyRuns.pollState })
				.from(journeyRuns)
				.where(
					and(
						eq(journeyRuns.journeyRef, journeyRef),
						eq(journeyRuns.dayOfOperation, dayOfOperation),
					),
				);

			if (row?.pollState === "done") {
				stats.skipped++;
				continue;
			}

			const r = details[i];

			if (r.kind === "terminal") {
				console.error(`kvv terminal error for ${journeyRef}: ${r.errCode}`);
				await markRunDone(db, journeyRef, dayOfOperation);
				stats.terminal++;
				stats.done++;
				continue;
			}

			if (r.kind === "transient") {
				const next = efaFailCount + 1;
				if (next >= EFA_MAX_FAIL_COUNT) {
					console.error(
						`kvv gave up on ${journeyRef} after ${EFA_MAX_FAIL_COUNT} transient errors (last: ${r.errCode})`,
					);
					await markRunDone(db, journeyRef, dayOfOperation);
					stats.terminal++;
					stats.done++;
					continue;
				}
				console.error(
					`kvv transient error for ${journeyRef} (attempt ${next}/${EFA_MAX_FAIL_COUNT}): ${r.errCode}`,
				);
				await boss.send(
					KVV_POLL_QUEUE,
					{
						journeyRef,
						dayOfOperation,
						pollCount,
						efaFailCount: next,
					} satisfies KvvPollJob,
					{ startAfter: RETRY_DELAY_S },
				);
				stats.transient++;
				continue;
			}

			const detail = r.detail;
			await upsertRunFromEfa(db, journeyRef, dayOfOperation, detail, now);
			await upsertEfaStops(db, journeyRef, dayOfOperation, detail.stops);

			// Populate the polyline cache opportunistically on first
			// sighting of a given line stateless. Fire-and-forget — a
			// failure here doesn't compromise the schedule data, and
			// every other poll of the same stateless will retry.
			if (pollCount === 0) {
				ensureShape(journeyRef, detail).catch((e) =>
					console.error(`kvv shape fetch failed for ${journeyRef}:`, e),
				);
			}

			const hasRt =
				detail.status === "MONITORED" ||
				detail.stops.some((s) => s.rtDepTime || s.rtArrTime);

			const markedDone = await handleKvvPollResult(
				db,
				boss,
				journeyRef,
				dayOfOperation,
				pollCount,
				detail.stops,
				hasRt,
			);

			stats.ok++;
			if (markedDone) stats.done++;
		} catch (e) {
			console.error(`kvv failed to process ${journeyRef}:`, e);
			throw e;
		}
	}

	console.log(
		`kvv poll: batch=${jobs.length} ok=${stats.ok} skipped=${stats.skipped} transient=${stats.transient} terminal=${stats.terminal} done=${stats.done}`,
	);
}

function isHardCapReached(
	originDep?: string,
	destArr?: string,
	dayOfOp?: string,
): boolean {
	if (!destArr || !dayOfOp) return false;
	const arr = berlinTime(dayOfOp, destArr);
	const duration = originDep
		? arr.diff(berlinTime(dayOfOp, originDep), "minute")
		: 0;
	// Buffer = trip duration or 15 min floor — same as RMV. A 5-min
	// tram line gets the floor; a 60-min Stadtbahn gets 60 min, catching
	// late-running trips without extending past midnight into a next-day
	// poll pile.
	const buffer = Math.max(duration, 15);
	return nowBerlin().isAfter(arr.add(buffer, "minute"));
}

async function handleKvvPollResult(
	db: Db,
	boss: PgBoss,
	journeyRef: string,
	dayOfOperation: string,
	pollCount: number,
	stops: { depTime?: string; arrTime?: string; name: string }[],
	hasRt: boolean,
): Promise<boolean> {
	const lastIdx = stops.length - 1;
	const origin = stops[0];
	const dest = stops[lastIdx];
	const hardCapReached = isHardCapReached(
		origin?.depTime,
		dest?.arrTime,
		dayOfOperation,
	);
	const hasDeparted =
		!origin?.depTime ||
		nowBerlin().isAfter(berlinTime(dayOfOperation, origin.depTime));
	const noRtAfterMaxPolls = !hasRt && pollCount >= 10 && hasDeparted;
	const maxPollsReached = pollCount >= 90;

	if (hardCapReached || noRtAfterMaxPolls || maxPollsReached) {
		await markRunDone(db, journeyRef, dayOfOperation);
		return true;
	}
	await boss.send(
		KVV_POLL_QUEUE,
		{
			journeyRef,
			dayOfOperation,
			pollCount: pollCount + 1,
		} satisfies KvvPollJob,
		{ startAfter: RETRY_DELAY_S },
	);
	return false;
}

async function upsertRunFromEfa(
	db: Db,
	ref: string,
	dayOfOperation: string,
	detail: EfaTripDetail,
	snapshotAt: string,
): Promise<void> {
	const stops = detail.stops;
	if (stops.length < 2) return;

	const origin = stops[0];
	const dest = stops[stops.length - 1];
	if (!origin.depTime || !dest.arrTime) return;

	const line = detail.product?.line ?? detail.product?.name;
	if (!line) return;

	const hasRt =
		detail.status === "MONITORED" ||
		stops.some((s) => s.rtDepTime || s.rtArrTime);

	await db
		.insert(journeyRuns)
		.values({
			journeyRef: ref,
			dayOfOperation,
			line,
			category:
				normalizeEfaCategory(detail.product?.catOut ?? detail.product?.name) ??
				detail.product?.catOut ??
				null,
			operator: detail.product?.operator ?? null,
			originStopId: origin.extId,
			originName: origin.name,
			originDepTime: origin.depTime,
			destStopId: dest.extId,
			destName: dest.name,
			destArrTime: dest.arrTime,
			cancelled: !!detail.cancelled,
			wasTracked: hasRt,
			pollState: "polling",
			snapshotAt,
		})
		.onConflictDoUpdate({
			target: [journeyRuns.journeyRef, journeyRuns.dayOfOperation],
			set: {
				line: excluded(journeyRuns.line),
				category: excluded(journeyRuns.category),
				operator: excluded(journeyRuns.operator),
				originStopId: excluded(journeyRuns.originStopId),
				originName: excluded(journeyRuns.originName),
				originDepTime: excluded(journeyRuns.originDepTime),
				destStopId: excluded(journeyRuns.destStopId),
				destName: excluded(journeyRuns.destName),
				destArrTime: excluded(journeyRuns.destArrTime),
				cancelled: sql`${journeyRuns.cancelled} OR ${excluded(journeyRuns.cancelled)}`,
				wasTracked: sql`${journeyRuns.wasTracked} OR ${excluded(journeyRuns.wasTracked)}`,
				pollState: sql`'polling'`,
				snapshotAt: excluded(journeyRuns.snapshotAt),
			},
		});
}

/** Populate the `stateless`-keyed polyline cache if we don't already
 * have it. Called from the poll's first-sighting path so we amortize
 * the extra HTTP across every trip on that line for a week. Pulled into
 * a named function to keep the main batch loop legible. */
async function ensureShape(
	journeyRef: string,
	detail: EfaTripDetail,
): Promise<void> {
	const decoded = decodeTripRef(journeyRef);
	if (!decoded) return;
	if (shapeFromL1(decoded.stateless)) return;

	const key = shapeCacheKey(decoded.stateless);
	const l2 = await cacheGet<[number, number][]>(key);
	if (l2 && l2.length > 0) {
		shapeToL1(decoded.stateless, l2);
		return;
	}

	const origin = detail.stops[0];
	const dest = detail.stops[detail.stops.length - 1];
	if (!origin?.extId || !dest?.extId || !origin.depTime) return;

	const shape = await efaTripShape({
		stateless: decoded.stateless,
		originId: origin.extId,
		destinationId: dest.extId,
		yyyymmdd: decoded.yyyymmdd,
		hhmm: origin.depTime.slice(0, 5).replace(":", ""),
	});
	if (!shape || shape.length === 0) return;
	shapeToL1(decoded.stateless, shape);
	await cachePut(key, shape, SHAPE_TTL_MS);
}

async function upsertEfaStops(
	db: Db,
	journeyRef: string,
	dayOfOperation: string,
	stops: EfaTripDetail["stops"],
): Promise<void> {
	if (stops.length === 0) return;
	const values = stops.map((s) => ({
		journeyRef,
		dayOfOperation,
		routeIdx: s.routeIdx,
		stopId: s.extId,
		stopName: s.name,
		depTime: s.depTime ?? null,
		arrTime: s.arrTime ?? null,
		rtDepTime: s.rtDepTime ?? null,
		rtArrTime: s.rtArrTime ?? null,
		cancelled: !!s.cancelled,
		// EFA populates coords on every stop. Guard against the 0,0
		// fallback in kvv-efa.ts (we emit 0,0 when parsing fails) so a
		// null column beats a lat-0/lon-0 point off Africa.
		lat: s.lat !== 0 ? s.lat : null,
		lon: s.lon !== 0 ? s.lon : null,
	}));

	await db
		.insert(journeyStops)
		.values(values)
		.onConflictDoUpdate({
			target: [
				journeyStops.journeyRef,
				journeyStops.dayOfOperation,
				journeyStops.routeIdx,
			],
			set: {
				rtDepTime: sql`COALESCE(${excluded(journeyStops.rtDepTime)}, ${journeyStops.rtDepTime})`,
				rtArrTime: sql`COALESCE(${excluded(journeyStops.rtArrTime)}, ${journeyStops.rtArrTime})`,
				cancelled: sql`${journeyStops.cancelled} OR ${excluded(journeyStops.cancelled)}`,
				lat: sql`COALESCE(${excluded(journeyStops.lat)}, ${journeyStops.lat})`,
				lon: sql`COALESCE(${excluded(journeyStops.lon)}, ${journeyStops.lon})`,
			},
		});
}

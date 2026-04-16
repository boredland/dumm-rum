import { and, eq, sql } from "drizzle-orm";
import type PgBoss from "pg-boss";
import type { Db } from "../db/client.ts";
import { excluded } from "../db/helpers.ts";
import { journeyRuns, journeyStops } from "../db/schema.ts";
import { type MgateJourneyDetail, mgateJourneyDetailsBatch } from "./mgate.ts";
import { notifyJourneyIssues } from "./telegram.ts";
import { berlinTime, nowBerlin } from "./utils.ts";

export interface PollJob {
	journeyRef: string;
	dayOfOperation: string;
	pollCount: number;
	mgateFailCount?: number;
}

export const POLL_QUEUE = "journey-poll";

// How many consecutive transient mgate failures before giving up on a
// run and marking it done. mgate's PARAMETER error can flip back to OK
// on the next call, so one blip shouldn't retire a run.
const MGATE_MAX_FAIL_COUNT = 5;
const RETRY_DELAY_S = 60;

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

export async function processPollBatch(
	db: Db,
	boss: PgBoss,
	jobs: PgBoss.Job<PollJob>[],
): Promise<void> {
	const now = new Date().toISOString();
	const stats: BatchStats = {
		ok: 0,
		skipped: 0,
		transient: 0,
		terminal: 0,
		done: 0,
	};

	// Fan out a single mgate POST for the whole batch. mgate's svcReqL
	// supports per-request error isolation, so this is ~1 HTTP instead of N.
	const batchRefs = jobs.map((j) => j.data.journeyRef);
	const mgateResults = await mgateJourneyDetailsBatch(batchRefs);

	for (let i = 0; i < jobs.length; i++) {
		const job = jobs[i];
		const {
			journeyRef,
			dayOfOperation,
			pollCount,
			mgateFailCount = 0,
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

			const mgateResult = mgateResults[i];

			if (mgateResult.kind === "terminal") {
				console.error(
					`mgate terminal error for ${journeyRef}: ${mgateResult.errCode}`,
				);
				await markRunDone(db, journeyRef, dayOfOperation);
				stats.terminal++;
				stats.done++;
				continue;
			}

			if (mgateResult.kind === "transient") {
				const nextFailCount = mgateFailCount + 1;
				if (nextFailCount >= MGATE_MAX_FAIL_COUNT) {
					console.error(
						`mgate gave up on ${journeyRef} after ${MGATE_MAX_FAIL_COUNT} transient errors (last: ${mgateResult.errCode})`,
					);
					await markRunDone(db, journeyRef, dayOfOperation);
					stats.terminal++;
					stats.done++;
					continue;
				}
				console.error(
					`mgate transient error for ${journeyRef} (attempt ${nextFailCount}/${MGATE_MAX_FAIL_COUNT}): ${mgateResult.errCode}`,
				);
				await boss.send(
					POLL_QUEUE,
					{
						journeyRef,
						dayOfOperation,
						pollCount,
						mgateFailCount: nextFailCount,
					} satisfies PollJob,
					{ startAfter: RETRY_DELAY_S },
				);
				stats.transient++;
				continue;
			}

			const mgDetail = mgateResult.detail;
			const mgStops = mgDetail.stops;

			await upsertJourneyRunFromMgate(
				db,
				journeyRef,
				dayOfOperation,
				mgDetail,
				now,
			);
			await upsertMgateStops(db, journeyRef, dayOfOperation, mgStops);

			if (pollCount === 0 && process.env.TELEGRAM_BOT_TOKEN) {
				const mgLine = mgDetail.product?.line ?? mgDetail.product?.name;
				const dest = mgStops[mgStops.length - 1];
				if (mgLine) {
					await notifyJourneyIssues(
						process.env.TELEGRAM_BOT_TOKEN,
						journeyRef,
						dayOfOperation,
						mgLine,
						dest?.name ?? "",
					).catch((e) =>
						console.error(`telegram notify failed for ${journeyRef}:`, e),
					);
				}
			}

			const mgHasRtData =
				mgDetail.lastPos != null ||
				mgStops.some((s) => s.rtDepTime || s.rtArrTime);

			const markedDone = await handlePollResult(
				db,
				boss,
				journeyRef,
				dayOfOperation,
				pollCount,
				mgStops,
				mgHasRtData,
				mgDetail.lastPassRouteIdx,
			);

			stats.ok++;
			if (markedDone) stats.done++;
		} catch (e) {
			console.error(`Failed to process journey ${journeyRef}:`, e);
			// Throwing bubbles to pg-boss, which will retry per queue config.
			throw e;
		}
	}

	console.log(
		`poll: batch=${jobs.length} ok=${stats.ok} skipped=${stats.skipped} transient=${stats.transient} terminal=${stats.terminal} done=${stats.done}`,
	);
}

function isHardCapReached(
	originDep?: string,
	destArr?: string,
	dayOfOp?: string,
): boolean {
	if (!destArr || !dayOfOp) return false;
	const arr = berlinTime(dayOfOp, destArr);
	const durationMin = originDep
		? arr.diff(berlinTime(dayOfOp, originDep), "minute")
		: 0;
	const buffer = Math.max(durationMin, 15);
	return nowBerlin().isAfter(arr.add(buffer, "minute"));
}

async function handlePollResult(
	db: Db,
	boss: PgBoss,
	journeyRef: string,
	dayOfOperation: string,
	pollCount: number,
	stops: { depTime?: string; arrTime?: string; name: string }[],
	hasRtData: boolean,
	lastPassRouteIdx: number | null | undefined,
): Promise<boolean> {
	const lastStopIdx = stops.length - 1;
	const passedLastStop =
		lastPassRouteIdx != null &&
		lastStopIdx >= 0 &&
		lastPassRouteIdx >= lastStopIdx;
	const origin = stops[0];
	const dest = stops[lastStopIdx];
	const hardCapReached = isHardCapReached(
		origin?.depTime,
		dest?.arrTime,
		dayOfOperation,
	);
	const hasDeparted =
		!origin?.depTime ||
		nowBerlin().isAfter(berlinTime(dayOfOperation, origin.depTime));
	const noRtAfterMaxPolls = !hasRtData && pollCount >= 10 && hasDeparted;
	const maxPollsReached = pollCount >= 90;

	if (
		passedLastStop ||
		hardCapReached ||
		noRtAfterMaxPolls ||
		maxPollsReached
	) {
		await db
			.update(journeyRuns)
			.set({ pollState: "done" })
			.where(
				and(
					eq(journeyRuns.journeyRef, journeyRef),
					eq(journeyRuns.dayOfOperation, dayOfOperation),
				),
			);
		return true;
	}
	await boss.send(
		POLL_QUEUE,
		{
			journeyRef,
			dayOfOperation,
			pollCount: pollCount + 1,
		} satisfies PollJob,
		{ startAfter: RETRY_DELAY_S },
	);
	return false;
}

async function upsertJourneyRunFromMgate(
	db: Db,
	ref: string,
	dayOfOperation: string,
	mg: MgateJourneyDetail,
	snapshotAt: string,
): Promise<void> {
	const stops = mg.stops;
	if (stops.length < 2) return;

	const origin = stops[0];
	const dest = stops[stops.length - 1];
	if (!origin.depTime || !dest.arrTime) return;

	const line = mg.product?.line ?? mg.product?.name;
	if (!line) return;

	const hasRtData =
		mg.lastPos != null || stops.some((s) => s.rtDepTime || s.rtArrTime);

	await db
		.insert(journeyRuns)
		.values({
			journeyRef: ref,
			dayOfOperation,
			line,
			category: mg.product?.catOut ?? null,
			operator: mg.product?.operator ?? null,
			originStopId: origin.extId,
			originName: origin.name,
			originDepTime: origin.depTime,
			destStopId: dest.extId,
			destName: dest.name,
			destArrTime: dest.arrTime,
			cancelled: !!mg.cancelled,
			wasTracked: hasRtData,
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

async function upsertMgateStops(
	db: Db,
	journeyRef: string,
	dayOfOperation: string,
	stops: MgateJourneyDetail["stops"],
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
			},
		});
}

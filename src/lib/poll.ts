import { and, eq, sql } from "drizzle-orm";
import type PgBoss from "pg-boss";
import type { Db } from "../db/client.ts";
import { excluded } from "../db/helpers.ts";
import { journeyRuns, journeyStops, knownStops } from "../db/schema.ts";
import {
	isExcludedOperator,
	isLongDistanceCategory,
	isUnattributedMainzBus,
} from "./discover.ts";
import { type MgateJourneyDetail, mgateJourneyDetailsBatch } from "./mgate.ts";
import { slugForStop } from "./stations.ts";
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

/** Drops the stop visits of a run that a poll revealed to be long-distance
 * traffic, and tombstones the run itself.
 *
 * The run row stays, marked done, on purpose. Deleting it outright would
 * let the next station-board pass re-insert the same journey, because
 * `onConflictDoNothing` in discover.ts has nothing left to conflict with;
 * the poller would then delete it again on every cycle. The tombstone
 * keeps that loop closed. It carries the long-distance category, so
 * COLLECTED_TRAFFIC keeps it out of every read query. */
async function tombstoneLongDistanceRun(
	db: Db,
	journeyRef: string,
	dayOfOperation: string,
	category: string | null,
): Promise<void> {
	await db
		.delete(journeyStops)
		.where(
			and(
				eq(journeyStops.journeyRef, journeyRef),
				eq(journeyStops.dayOfOperation, dayOfOperation),
			),
		);
	await db
		.update(journeyRuns)
		.set({ category, pollState: "done" })
		.where(
			and(
				eq(journeyRuns.journeyRef, journeyRef),
				eq(journeyRuns.dayOfOperation, dayOfOperation),
			),
		);
}

/** Marks a run the poller must ignore and the site must not show.
 *
 * A distinct poll state, rather than reusing "done": the read guard then
 * tests one unambiguous fact instead of re-deriving "is this Mainz?" from
 * operator and origin columns that the tombstone does not control. */
export const EXCLUDED_POLL_STATE = "excluded";

/** Drops the stop visits of a run whose operator we do not collect, and
 * marks the run excluded so the poller leaves it alone.
 *
 * The run row stays for the same reason as the long-distance tombstone: a
 * hard delete leaves `onConflictDoNothing` in discover.ts nothing to
 * conflict with, so the next station-board pass re-inserts the journey and
 * the poller removes it again, every cycle. */
async function tombstoneExcludedRun(
	db: Db,
	journeyRef: string,
	dayOfOperation: string,
): Promise<void> {
	await db
		.delete(journeyStops)
		.where(
			and(
				eq(journeyStops.journeyRef, journeyRef),
				eq(journeyStops.dayOfOperation, dayOfOperation),
			),
		);
	await db
		.update(journeyRuns)
		.set({ pollState: EXCLUDED_POLL_STATE })
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

			// JourneyDetails can report a different category than the station
			// board did, so a run can turn out to be long-distance after
			// discovery accepted it. Stop tracking it: we no longer keep that
			// traffic.
			const detailCategory = mgDetail.product?.catOut ?? null;
			if (isLongDistanceCategory(detailCategory)) {
				await tombstoneLongDistanceRun(
					db,
					journeyRef,
					dayOfOperation,
					detailCategory,
				);
				stats.terminal++;
				continue;
			}

			// Same story for an excluded operator: the station board sometimes
			// omits the operator that JourneyDetails then supplies, so a Mainz
			// bus can get this far.
			//
			// Tombstoned, not deleted. Discovery filters on the board's own
			// operator field, which is exactly the one that was missing, so a
			// deleted row would be re-inserted on the next pass and deleted
			// again on every cycle. The tombstone keeps the poller off it, and
			// the run carries no stops, so every stop-based query ignores it.
			//
			// The origin check earns its place here rather than in discovery
			// alone: the board only knows the station it was queried for, while
			// JourneyDetails gives the journey's real first stop. That is how a
			// Mainz bus with no operator reaches us.
			const detailOperator = mgDetail.product?.operator ?? null;
			const detailOrigin = mgStops[0]?.name ?? "";
			if (
				isExcludedOperator(detailOperator) ||
				isUnattributedMainzBus(detailOperator, detailCategory, detailOrigin)
			) {
				await tombstoneExcludedRun(db, journeyRef, dayOfOperation);
				stats.terminal++;
				continue;
			}

			await upsertJourneyRunFromMgate(
				db,
				journeyRef,
				dayOfOperation,
				mgDetail,
				now,
			);
			await upsertMgateStops(db, journeyRef, dayOfOperation, mgStops);
			await upsertStopSlugs(
				db,
				mgStops.map((s) => ({ stopId: s.extId, stopName: s.name })),
			);

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

/** One-off backfill for stops discovered before the poller started
 * writing the rollup. `nameToSlug` isn't reproducible in SQL, so this
 * can't be a plain UPDATE — it reads the distinct stops missing a row and
 * slugs them in JS. Takes the newest name per stop (matching what a live
 * poll would write) so the two writers agree instead of fighting over the
 * row. No-ops once every stop is covered.
 *
 * Distinct stop ids come from a recursive index skip-scan, not `GROUP BY
 * stop_id`. Postgres has no loose index scan, so the grouping form reads
 * every row of journey_stops — at 25M visits that is ~1 s even fully
 * cached, paid on every boot only to learn that nothing is missing.
 * Walking `idx_journey_stops_stop_day` one id at a time is one index
 * probe per distinct stop instead, and stays flat as history grows.
 *
 * The name is resolved per missing stop and scoped to that stop's newest
 * day: an unscoped MAX(stop_name) re-reads every visit of the stop and
 * puts the sequential scan straight back. */
export async function backfillKnownStops(db: Db): Promise<number> {
	const rows = (await db.execute(sql`
		WITH RECURSIVE ids AS (
			(SELECT ${journeyStops.stopId} AS stop_id FROM ${journeyStops}
				ORDER BY ${journeyStops.stopId} LIMIT 1)
			UNION ALL
			SELECT (SELECT js.stop_id FROM ${journeyStops} js
				WHERE js.stop_id > ids.stop_id ORDER BY js.stop_id LIMIT 1)
			FROM ids WHERE ids.stop_id IS NOT NULL
		)
		SELECT ids.stop_id, newest.stop_name
		FROM ids
		CROSS JOIN LATERAL (
			SELECT MAX(js.stop_name) AS stop_name FROM ${journeyStops} js
			WHERE js.stop_id = ids.stop_id
				AND js.day_of_operation = (
					SELECT MAX(d.day_of_operation) FROM ${journeyStops} d
					WHERE d.stop_id = ids.stop_id
				)
		) newest
		WHERE ids.stop_id IS NOT NULL
			AND NOT EXISTS (
				SELECT 1 FROM ${knownStops} ks WHERE ks.stop_id = ids.stop_id
			)
		ORDER BY ids.stop_id
	`)) as unknown as { stop_id: string; stop_name: string | null }[];
	if (rows.length === 0) return 0;

	await upsertStopSlugs(
		db,
		rows.flatMap((r) =>
			r.stop_name ? [{ stopId: r.stop_id, stopName: r.stop_name }] : [],
		),
	);
	return rows.length;
}

/** Keeps the `known_stops` slug rollup current so `findStopBySlug` is a
 * single indexed lookup. `nameToSlug` does umlaut transliteration plus NFD
 * normalization in JS and isn't reproducible in SQL, so the slug has to be
 * written here — otherwise resolving one would mean scanning every stop and
 * matching in app memory.
 *
 * Rows are ordered by stop id so concurrent writers (replicas booting, or a
 * backfill racing a poll batch) take the same locks in the same order and
 * can't deadlock. */
async function upsertStopSlugs(
	db: Db,
	stops: { stopId: string; stopName: string }[],
): Promise<void> {
	const byId = new Map<string, string>();
	for (const s of stops) {
		if (s.stopId && s.stopName) byId.set(s.stopId, s.stopName);
	}
	if (byId.size === 0) return;

	const values = [...byId]
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
		.map(([stopId, stopName]) => ({
			stopId,
			stopName,
			slug: slugForStop([stopId], stopName),
		}));

	await db
		.insert(knownStops)
		.values(values)
		.onConflictDoUpdate({
			target: knownStops.stopId,
			set: {
				stopName: excluded(knownStops.stopName),
				slug: excluded(knownStops.slug),
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

import { and, eq, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { createDb } from "../db/client";
import { coalesce, d1BatchSize, excluded } from "../db/helpers";
import { journeyPositions, journeyRuns, journeyStops } from "../db/schema";
import { createHafasClient } from "./hafas";
import type { components } from "./hafas-types";
import { mgateJourneyDetail } from "./mgate";
import { notifyJourneyIssues } from "./telegram";
import { berlinTime, extractPolyline, nowBerlin, pickKey } from "./utils";

type JourneyDetail = components["schemas"]["JourneyDetail"];

export async function processJourneyBatch(
	batch: MessageBatch<JourneyPollMessage>,
	env: Cloudflare.Env,
): Promise<void> {
	const db = createDb(env.DB);
	const now = new Date().toISOString();

	for (const msg of batch.messages) {
		const { journeyRef, dayOfOperation, pollCount } = msg.body;

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
				msg.ack();
				continue;
			}

			const mgateResult = await mgateJourneyDetail(journeyRef);

			if (!mgateResult) {
				console.error(`mgate failed for ${journeyRef}, trying REST API`);
				const client = createHafasClient(pickKey(env.RMV_API_KEY));
				const { data, error } = await client.GET("/journeyDetail", {
					params: {
						query: { id: journeyRef, poly: "1", format: "json" },
					},
				});

				if (error || !data) {
					const isQuota =
						typeof error === "object" &&
						error !== null &&
						"errorCode" in error &&
						(error as { errorCode?: string }).errorCode === "API_QUOTA";
					console.error(`journeyDetail failed for ${journeyRef}:`, error);
					if (isQuota) {
						msg.ack();
						await env.JOURNEY_QUEUE.send(
							{ journeyRef, dayOfOperation, pollCount: pollCount + 1 },
							{ delaySeconds: 1800 },
						);
					} else {
						msg.retry();
					}
					continue;
				}

				const detail = data as JourneyDetail;
				const stops = detail.Stops?.Stop ?? [];

				if (detail.lastPos) {
					await db.insert(journeyPositions).values({
						journeyRef,
						dayOfOperation,
						lat: detail.lastPos.lat,
						lon: detail.lastPos.lon,
						reportedAt: detail.lastPosReported ?? now,
						routeIdx: detail.lastPassRouteIdx ?? null,
						rtRouteIdx: detail.rtLastPassRouteIdx ?? null,
						capturedAt: now,
					});
				}

				await upsertJourneyRun(db, journeyRef, dayOfOperation, detail, now);
				await upsertJourneyStops(db, journeyRef, dayOfOperation, stops);

				const product = detail.Product?.[0];
				const restLine = product?.line ?? product?.name;
				const restHasRtData =
					detail.lastPos != null ||
					stops.some((s) => s.rtDepTime || s.rtArrTime);

				await handlePollResult(
					db,
					env,
					msg,
					journeyRef,
					dayOfOperation,
					pollCount,
					restLine,
					stops,
					restHasRtData,
					detail.lastPassRouteIdx,
				);
				continue;
			}

			const mgStops = mgateResult.stops;

			if (mgateResult.lastPos) {
				await db.insert(journeyPositions).values({
					journeyRef,
					dayOfOperation,
					lat: mgateResult.lastPos.lat,
					lon: mgateResult.lastPos.lon,
					reportedAt: mgateResult.lastPosReported ?? now,
					routeIdx: mgateResult.lastPassRouteIdx ?? null,
					rtRouteIdx: null,
					capturedAt: now,
				});
			}

			await upsertJourneyRunFromMgate(
				db,
				journeyRef,
				dayOfOperation,
				mgateResult,
				now,
			);
			await upsertMgateStops(db, journeyRef, dayOfOperation, mgStops);

			const mgLine = mgateResult.product?.line ?? mgateResult.product?.name;
			const mgHasRtData =
				mgateResult.lastPos != null ||
				mgStops.some((s) => s.rtDepTime || s.rtArrTime);

			await handlePollResult(
				db,
				env,
				msg,
				journeyRef,
				dayOfOperation,
				pollCount,
				mgLine,
				mgStops,
				mgHasRtData,
				mgateResult.lastPassRouteIdx,
			);
		} catch (e) {
			console.error(`Failed to process journey ${journeyRef}:`, e);
			msg.retry();
		}
	}
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
	env: Cloudflare.Env,
	msg: Message<JourneyPollMessage>,
	journeyRef: string,
	dayOfOperation: string,
	pollCount: number,
	line: string | undefined,
	stops: { depTime?: string; arrTime?: string; name: string }[],
	hasRtData: boolean,
	lastPassRouteIdx: number | null | undefined,
): Promise<void> {
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
	const noRtAfterMaxPolls = !hasRtData && pollCount >= 2 && hasDeparted;
	const maxPollsReached = pollCount >= 15;

	if (pollCount === 0 && line && env.TELEGRAM_BOT_TOKEN) {
		await notifyJourneyIssues(
			db,
			env.TELEGRAM_BOT_TOKEN,
			journeyRef,
			dayOfOperation,
			line,
			dest?.name ?? "",
		);
	}

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
		msg.ack();
	} else {
		msg.ack();
		await env.JOURNEY_QUEUE.send(
			{ journeyRef, dayOfOperation, pollCount: pollCount + 1 },
			{ delaySeconds: 300 },
		);
	}
}

async function upsertJourneyRun(
	db: Db,
	ref: string,
	dayOfOperation: string,
	detail: JourneyDetail,
	snapshotAt: string,
): Promise<void> {
	const stops = detail.Stops?.Stop ?? [];
	if (stops.length < 2) return;

	const origin = stops[0];
	const dest = stops[stops.length - 1];
	const originDepTime = origin.depTime;
	const destArrTime = dest.arrTime;
	if (!originDepTime || !destArrTime) return;

	const product = detail.Product?.[0];
	const line = product?.line ?? product?.name;
	if (!line) return;

	const cancelledStops = stops.filter((s) => s.cancelled).length;
	const hasRtData =
		stops.some((s) => s.rtDepTime || s.rtArrTime) || detail.lastPos != null;

	const polyline = extractPolyline(detail);

	await db
		.insert(journeyRuns)
		.values({
			journeyRef: ref,
			dayOfOperation,
			line,
			category: product?.catOut ?? null,
			operator: product?.operator ?? null,
			lineId: product?.lineId ?? null,
			originStopId: origin.extId,
			originName: origin.name,
			originDepTime,
			destStopId: dest.extId,
			destName: dest.name,
			destArrTime,
			status: detail.JourneyStatus ?? "P",
			cancelled: detail.cancelled ? 1 : 0,
			partCancelled: Number(detail.partCancelled || cancelledStops > 0),
			cancelledStopCount: cancelledStops,
			totalStopCount: stops.length,
			wasTracked: hasRtData ? 1 : 0,
			pollState: "polling",
			polyline,
			snapshotAt,
		})
		.onConflictDoUpdate({
			target: [journeyRuns.journeyRef, journeyRuns.dayOfOperation],
			set: {
				line: excluded(journeyRuns.line),
				category: excluded(journeyRuns.category),
				operator: excluded(journeyRuns.operator),
				lineId: excluded(journeyRuns.lineId),
				originStopId: excluded(journeyRuns.originStopId),
				originName: excluded(journeyRuns.originName),
				originDepTime: excluded(journeyRuns.originDepTime),
				destStopId: excluded(journeyRuns.destStopId),
				destName: excluded(journeyRuns.destName),
				destArrTime: excluded(journeyRuns.destArrTime),
				status: excluded(journeyRuns.status),
				cancelled: excluded(journeyRuns.cancelled),
				partCancelled: excluded(journeyRuns.partCancelled),
				cancelledStopCount: excluded(journeyRuns.cancelledStopCount),
				totalStopCount: excluded(journeyRuns.totalStopCount),
				wasTracked: sql`MAX(${journeyRuns.wasTracked}, ${excluded(journeyRuns.wasTracked)})`,
				pollState: sql`'polling'`,
				polyline: sql`COALESCE(${excluded(journeyRuns.polyline)}, ${journeyRuns.polyline})`,
				snapshotAt: excluded(journeyRuns.snapshotAt),
			},
		});
}

type StopType = components["schemas"]["StopType"];

async function upsertJourneyStops(
	db: Db,
	journeyRef: string,
	dayOfOperation: string,
	stops: StopType[],
): Promise<void> {
	if (stops.length === 0) return;

	const batchSize = d1BatchSize(journeyStops);

	for (let i = 0; i < stops.length; i += batchSize) {
		const batch = stops.slice(i, i + batchSize);
		await db
			.insert(journeyStops)
			.values(
				batch.map((s, j) => ({
					journeyRef,
					dayOfOperation,
					routeIdx: s.routeIdx ?? i + j,
					stopId: s.extId,
					stopName: s.name,
					depTime: s.depTime ?? null,
					arrTime: s.arrTime ?? null,
					rtDepTime: s.rtDepTime ?? null,
					rtArrTime: s.rtArrTime ?? null,
					cancelled: s.cancelled ? 1 : 0,
					lat: s.lat ?? null,
					lon: s.lon ?? null,
				})),
			)
			.onConflictDoUpdate({
				target: [
					journeyStops.journeyRef,
					journeyStops.dayOfOperation,
					journeyStops.routeIdx,
				],
				set: {
					rtDepTime: coalesce(
						excluded(journeyStops.rtDepTime),
						journeyStops.rtDepTime,
					),
					rtArrTime: coalesce(
						excluded(journeyStops.rtArrTime),
						journeyStops.rtArrTime,
					),
					cancelled: sql`MAX(${journeyStops.cancelled}, ${excluded(journeyStops.cancelled)})`,
					lat: coalesce(excluded(journeyStops.lat), journeyStops.lat),
					lon: coalesce(excluded(journeyStops.lon), journeyStops.lon),
				},
			});
	}
}

async function upsertJourneyRunFromMgate(
	db: Db,
	ref: string,
	dayOfOperation: string,
	mg: import("./mgate").MgateJourneyDetail,
	snapshotAt: string,
): Promise<void> {
	const stops = mg.stops;
	if (stops.length < 2) return;

	const origin = stops[0];
	const dest = stops[stops.length - 1];
	if (!origin.depTime || !dest.arrTime) return;

	const line = mg.product?.line ?? mg.product?.name;
	if (!line) return;

	const cancelledStops = stops.filter((s) => s.cancelled).length;
	const hasRtData =
		mg.lastPos != null || stops.some((s) => s.rtDepTime || s.rtArrTime);

	let polyline: string | null = null;
	if (mg.polylineCrd && mg.polylineCrd.length >= 4) {
		const dim = mg.polylineDim ?? 2;
		const raw = mg.polylineDelta
			? decodeDeltaCrd(mg.polylineCrd, dim)
			: mg.polylineCrd;
		const points: [number, number][] = [];
		for (let i = 0; i < raw.length; i += dim) {
			points.push([raw[i + 1] / 1_000_000, raw[i] / 1_000_000]);
		}
		polyline = JSON.stringify(points);
	}

	await db
		.insert(journeyRuns)
		.values({
			journeyRef: ref,
			dayOfOperation,
			line,
			category: mg.product?.catOut ?? null,
			operator: mg.product?.operator ?? null,
			lineId: null,
			originStopId: origin.extId,
			originName: origin.name,
			originDepTime: origin.depTime,
			destStopId: dest.extId,
			destName: dest.name,
			destArrTime: dest.arrTime,
			status: mg.status ?? "P",
			cancelled: mg.cancelled ? 1 : 0,
			partCancelled: Number(mg.partCancelled || cancelledStops > 0),
			cancelledStopCount: cancelledStops,
			totalStopCount: stops.length,
			wasTracked: hasRtData ? 1 : 0,
			pollState: "polling",
			polyline,
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
				status: excluded(journeyRuns.status),
				cancelled: excluded(journeyRuns.cancelled),
				partCancelled: excluded(journeyRuns.partCancelled),
				cancelledStopCount: excluded(journeyRuns.cancelledStopCount),
				totalStopCount: excluded(journeyRuns.totalStopCount),
				wasTracked: sql`MAX(${journeyRuns.wasTracked}, ${excluded(journeyRuns.wasTracked)})`,
				pollState: sql`'polling'`,
				polyline: sql`COALESCE(${excluded(journeyRuns.polyline)}, ${journeyRuns.polyline})`,
				snapshotAt: excluded(journeyRuns.snapshotAt),
			},
		});
}

function decodeDeltaCrd(encoded: number[], dim: number): number[] {
	const result: number[] = [];
	const acc = new Array(dim).fill(0);
	for (let i = 0; i < encoded.length; i += dim) {
		for (let d = 0; d < dim; d++) {
			acc[d] += encoded[i + d];
			result.push(acc[d]);
		}
	}
	return result;
}

async function upsertMgateStops(
	db: Db,
	journeyRef: string,
	dayOfOperation: string,
	stops: import("./mgate").MgateJourneyDetail["stops"],
): Promise<void> {
	if (stops.length === 0) return;

	const batchSize = d1BatchSize(journeyStops);

	for (let i = 0; i < stops.length; i += batchSize) {
		const batch = stops.slice(i, i + batchSize);
		await db
			.insert(journeyStops)
			.values(
				batch.map((s) => ({
					journeyRef,
					dayOfOperation,
					routeIdx: s.routeIdx,
					stopId: s.extId,
					stopName: s.name,
					depTime: s.depTime ?? null,
					arrTime: s.arrTime ?? null,
					rtDepTime: s.rtDepTime ?? null,
					rtArrTime: s.rtArrTime ?? null,
					cancelled: s.cancelled ? 1 : 0,
					lat: s.lat ?? null,
					lon: s.lon ?? null,
				})),
			)
			.onConflictDoUpdate({
				target: [
					journeyStops.journeyRef,
					journeyStops.dayOfOperation,
					journeyStops.routeIdx,
				],
				set: {
					rtDepTime: coalesce(
						excluded(journeyStops.rtDepTime),
						journeyStops.rtDepTime,
					),
					rtArrTime: coalesce(
						excluded(journeyStops.rtArrTime),
						journeyStops.rtArrTime,
					),
					cancelled: sql`MAX(${journeyStops.cancelled}, ${excluded(journeyStops.cancelled)})`,
					lat: coalesce(excluded(journeyStops.lat), journeyStops.lat),
					lon: coalesce(excluded(journeyStops.lon), journeyStops.lon),
				},
			});
	}
}

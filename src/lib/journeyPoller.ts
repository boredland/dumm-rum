import { and, eq, getTableColumns, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { createDb } from "../db/client";
import { coalesce, excluded } from "../db/helpers";
import { journeyPositions, journeyRuns, journeyStops } from "../db/schema";
import { createHafasClient } from "./hafas";
import type { components } from "./hafas-types";
import { notifyJourneyIssues } from "./telegram";
import { berlinTime, nowBerlin } from "./utils";

type JourneyDetail = components["schemas"]["JourneyDetail"];

function pickKey(apiKeys: string): string {
	const keys = apiKeys
		.split(",")
		.map((k) => k.trim())
		.filter(Boolean);
	return keys[Math.floor(Math.random() * keys.length)];
}

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
				.update(journeyRuns)
				.set({
					pollState: sql`CASE WHEN ${journeyRuns.pollState} = 'done' THEN 'done' ELSE 'polling' END`,
				})
				.where(
					and(
						eq(journeyRuns.journeyRef, journeyRef),
						eq(journeyRuns.dayOfOperation, dayOfOperation),
					),
				)
				.returning({ pollState: journeyRuns.pollState });

			if (row?.pollState === "done") {
				msg.ack();
				continue;
			}

			const client = createHafasClient(pickKey(env.RMV_API_KEY));
			const { data, error } = await client.GET("/journeyDetail", {
				params: { query: { id: journeyRef, format: "json" } },
			});

			if (error || !data) {
				console.error(`journeyDetail failed for ${journeyRef}:`, error);
				msg.retry();
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

			await upsertJourneyRun(db, journeyRef, detail, now);
			await upsertJourneyStops(db, journeyRef, dayOfOperation, stops);

			const product = detail.Product?.[0];
			const line = product?.line ?? product?.name;
			const lastStopIdx = stops.length - 1;
			const passedLastStop =
				detail.lastPassRouteIdx != null &&
				lastStopIdx >= 0 &&
				detail.lastPassRouteIdx >= lastStopIdx;

			const hasRtData =
				detail.lastPos != null || stops.some((s) => s.rtDepTime || s.rtArrTime);

			const dest = stops[lastStopIdx];
			const hardCapReached = isHardCapReached(dest?.arrTime, dayOfOperation);

			const noRtAfterMaxPolls = !hasRtData && pollCount >= 2;

			if (pollCount === 0 && line && env.TELEGRAM_BOT_TOKEN) {
				const dest = stops[lastStopIdx];
				await notifyJourneyIssues(
					db,
					env.TELEGRAM_BOT_TOKEN,
					journeyRef,
					dayOfOperation,
					line,
					dest?.name ?? "",
				);
			}

			if (passedLastStop || hardCapReached || noRtAfterMaxPolls) {
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
				const delaySeconds = hasRtData ? 900 : 600;
				await env.JOURNEY_QUEUE.send(
					{ journeyRef, dayOfOperation, pollCount: pollCount + 1 },
					{ delaySeconds },
				);
			}
		} catch (e) {
			console.error(`Failed to process journey ${journeyRef}:`, e);
			msg.retry();
		}
	}
}

function isHardCapReached(destArr?: string, dayOfOp?: string): boolean {
	if (!destArr || !dayOfOp) return false;
	const hardCap = berlinTime(dayOfOp, destArr).add(15, "minute");
	return nowBerlin().isAfter(hardCap);
}

async function upsertJourneyRun(
	db: Db,
	ref: string,
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

	await db
		.insert(journeyRuns)
		.values({
			journeyRef: ref,
			dayOfOperation: detail.dayOfOperation,
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
			partCancelled: detail.partCancelled || cancelledStops > 0 ? 1 : 0,
			cancelledStopCount: cancelledStops,
			totalStopCount: stops.length,
			wasTracked: hasRtData ? 1 : 0,
			pollState: "polling",
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

	const D1_MAX_PARAMS = 100;
	const colCount = Object.keys(getTableColumns(journeyStops)).length;
	const batchSize = Math.max(1, Math.floor(D1_MAX_PARAMS / colCount));

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
				},
			});
	}
}

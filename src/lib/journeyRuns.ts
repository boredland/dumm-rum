import { and, eq, getTableColumns, inArray, isNotNull } from "drizzle-orm";
import type { Db } from "../db/client";
import { excluded } from "../db/helpers";
import { departures, journeyRuns } from "../db/schema";
import { createHafasClient } from "./hafas";
import type { components } from "./hafas-types";

type JourneyDetail = components["schemas"]["JourneyDetail"];
type JourneyRunRow = typeof journeyRuns.$inferInsert;

const FETCH_BATCH = 10;

/**
 * Pull distinct journey refs for a date and snapshot their canonical
 * outcome from /journeyDetail into `journey_runs`. RMV retains
 * cancellation metadata after a journey ages out but strips all
 * realtime times/positions, so this is intended for end-of-day runs
 * over yesterday's data.
 */
export async function snapshotJourneys(
	db: Db,
	apiKey: string,
	date: string,
): Promise<{ discovered: number; upserted: number; failed: number }> {
	const refRows = await db
		.selectDistinct({ ref: departures.journeyRef })
		.from(departures)
		.where(and(eq(departures.date, date), isNotNull(departures.journeyRef)));
	const refs = refRows.map((r) => r.ref).filter((r): r is string => r !== null);

	if (refs.length === 0) return { discovered: 0, upserted: 0, failed: 0 };

	const trackedRefRows = await db
		.selectDistinct({ ref: departures.journeyRef })
		.from(departures)
		.where(
			and(
				eq(departures.date, date),
				isNotNull(departures.journeyRef),
				inArray(departures.journeyStatus, ["R", "A", "S"]),
			),
		);
	const trackedRefs = new Set(
		trackedRefRows.map((r) => r.ref).filter((r): r is string => r !== null),
	);

	const client = createHafasClient(apiKey);
	const snapshotAt = new Date().toISOString();
	const rows: JourneyRunRow[] = [];
	let failed = 0;

	for (let i = 0; i < refs.length; i += FETCH_BATCH) {
		const chunk = refs.slice(i, i + FETCH_BATCH);
		const results = await Promise.all(
			chunk.map((ref) =>
				client
					.GET("/journeyDetail", {
						params: { query: { id: ref, format: "json" } },
					})
					.catch(() => null),
			),
		);
		for (let j = 0; j < chunk.length; j++) {
			const ref = chunk[j];
			const result = results[j];
			if (!result || result.error || !result.data) {
				failed++;
				continue;
			}
			const row = buildRow(
				ref,
				result.data as JourneyDetail,
				trackedRefs.has(ref),
				snapshotAt,
			);
			if (row) rows.push(row);
			else failed++;
		}
	}

	if (rows.length === 0)
		return { discovered: refs.length, upserted: 0, failed };

	const D1_MAX_PARAMS = 100;
	const colCount = Object.keys(getTableColumns(journeyRuns)).length;
	const writeBatch = Math.max(1, Math.floor(D1_MAX_PARAMS / colCount));

	for (let i = 0; i < rows.length; i += writeBatch) {
		const batch = rows.slice(i, i + writeBatch);
		try {
			await db
				.insert(journeyRuns)
				.values(batch)
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
						wasTracked: excluded(journeyRuns.wasTracked),
						snapshotAt: excluded(journeyRuns.snapshotAt),
					},
				});
		} catch (e) {
			console.error(`journey_runs batch insert failed at offset ${i}:`, e);
			failed += batch.length;
		}
	}

	return { discovered: refs.length, upserted: rows.length, failed };
}

function buildRow(
	ref: string,
	detail: JourneyDetail,
	wasTracked: boolean,
	snapshotAt: string,
): JourneyRunRow | null {
	const stops = detail.Stops?.Stop ?? [];
	if (stops.length < 2) return null;

	const origin = stops[0];
	const dest = stops[stops.length - 1];
	const originDepTime = origin.depTime;
	const destArrTime = dest.arrTime;
	if (!originDepTime || !destArrTime) return null;

	const product = detail.Product?.[0];
	const line = product?.line ?? product?.name;
	if (!line) return null;

	const cancelledStopCount = stops.reduce(
		(n, s) => (s.cancelled ? n + 1 : n),
		0,
	);

	return {
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
		cancelled: cancelledStopCount === stops.length ? 1 : 0,
		partCancelled: detail.partCancelled ? 1 : 0,
		cancelledStopCount,
		totalStopCount: stops.length,
		wasTracked: wasTracked ? 1 : 0,
		snapshotAt,
	};
}

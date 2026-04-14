import { and, eq, getTableColumns, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { excluded } from "../db/helpers";
import { journeyRuns } from "../db/schema";
import { createHafasClient } from "./hafas";
import type { components } from "./hafas-types";

type JourneyDetail = components["schemas"]["JourneyDetail"];
type JourneyRunRow = typeof journeyRuns.$inferInsert;

const FETCH_BATCH = 10;

/**
 * Re-snapshot journey_runs for a given date from /journeyDetail.
 * Enriches existing rows with full route topology (origin/dest, stop
 * count) that the initial discovery from /departureBoard doesn't have.
 */
export async function snapshotJourneys(
	db: Db,
	apiKey: string,
	date: string,
): Promise<{ discovered: number; upserted: number; failed: number }> {
	const refRows = await db
		.select({
			ref: journeyRuns.journeyRef,
			cancelled: journeyRuns.cancelled,
			wasTracked: journeyRuns.wasTracked,
		})
		.from(journeyRuns)
		.where(eq(journeyRuns.dayOfOperation, date));

	if (refRows.length === 0) return { discovered: 0, upserted: 0, failed: 0 };

	const client = createHafasClient(apiKey);
	const snapshotAt = new Date().toISOString();
	const rows: JourneyRunRow[] = [];
	let failed = 0;

	const refs = refRows.map((r) => r.ref);
	const existingData = new Map(refRows.map((r) => [r.ref, r]));

	for (let i = 0; i < refs.length; i += FETCH_BATCH) {
		const chunk = refs.slice(i, i + FETCH_BATCH);
		const results = await Promise.all(
			chunk.map((ref) =>
				client
					.GET("/journeyDetail", {
						params: { query: { id: ref, poly: "1", format: "json" } },
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
			const existing = existingData.get(ref);
			const row = buildRow(
				ref,
				result.data as JourneyDetail,
				existing ?? { cancelled: 0, wasTracked: 0 },
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
						cancelled: sql`MAX(${journeyRuns.cancelled}, ${excluded(journeyRuns.cancelled)})`,
						partCancelled: sql`MAX(${journeyRuns.partCancelled}, ${excluded(journeyRuns.partCancelled)})`,
						cancelledStopCount: sql`MAX(${journeyRuns.cancelledStopCount}, ${excluded(journeyRuns.cancelledStopCount)})`,
						totalStopCount: excluded(journeyRuns.totalStopCount),
						wasTracked: sql`MAX(${journeyRuns.wasTracked}, ${excluded(journeyRuns.wasTracked)})`,
						polyline: sql`COALESCE(${excluded(journeyRuns.polyline)}, ${journeyRuns.polyline})`,
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
	existing: { cancelled: number; wasTracked: number },
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

	const cancelledStops = stops.filter((s) => s.cancelled).length;

	const polyDesc = detail.PolylineGroup?.polylineDesc?.[0];
	const polyCrd = polyDesc?.crd;
	const dim = polyDesc?.dim ?? 2;
	let polyline: string | null = null;
	if (polyCrd && polyCrd.length >= dim * 2) {
		const points: [number, number][] = [];
		for (let k = 0; k < polyCrd.length; k += dim) {
			points.push([polyCrd[k + 1], polyCrd[k]]);
		}
		polyline = JSON.stringify(points);
	}

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
		cancelled: Math.max(detail.cancelled ? 1 : 0, existing.cancelled),
		partCancelled: detail.partCancelled || cancelledStops > 0 ? 1 : 0,
		cancelledStopCount: cancelledStops,
		totalStopCount: stops.length,
		wasTracked: existing.wasTracked,
		polyline,
		snapshotAt,
	};
}

import { eq, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { d1BatchSize, excluded } from "../db/helpers";
import { journeyRuns } from "../db/schema";
import { type MgateJourneyDetail, mgateJourneyDetailsBatch } from "./mgate";

type JourneyRunRow = typeof journeyRuns.$inferInsert;

const FETCH_BATCH = 10;

/**
 * Re-snapshot journey_runs for a given date via mgate JourneyDetails.
 * Enriches existing rows with full route topology (origin/dest, stop
 * count, polyline) that the initial discovery from StationBoard lacks.
 */
export async function snapshotJourneys(
	db: Db,
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

	const snapshotAt = new Date().toISOString();
	const rows: JourneyRunRow[] = [];
	let failed = 0;

	const refs = refRows.map((r) => r.ref);
	const existingData = new Map(refRows.map((r) => [r.ref, r]));

	for (let i = 0; i < refs.length; i += FETCH_BATCH) {
		const chunk = refs.slice(i, i + FETCH_BATCH);
		const results = await mgateJourneyDetailsBatch(chunk);
		for (let j = 0; j < chunk.length; j++) {
			const ref = chunk[j];
			const result = results[j];
			if (result.kind !== "ok") {
				failed++;
				continue;
			}
			const existing = existingData.get(ref);
			const row = buildRow(
				ref,
				date,
				result.detail,
				existing ?? { cancelled: 0, wasTracked: 0 },
				snapshotAt,
			);
			if (row) rows.push(row);
			else failed++;
		}
	}

	if (rows.length === 0)
		return { discovered: refs.length, upserted: 0, failed };

	const writeBatch = d1BatchSize(journeyRuns);

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
	dayOfOperation: string,
	detail: MgateJourneyDetail,
	existing: { cancelled: number; wasTracked: number },
	snapshotAt: string,
): JourneyRunRow | null {
	const stops = detail.stops;
	if (stops.length < 2) return null;

	const origin = stops[0];
	const dest = stops[stops.length - 1];
	if (!origin.depTime || !dest.arrTime) return null;

	const line = detail.product?.line ?? detail.product?.name;
	if (!line) return null;

	const cancelledStops = stops.filter((s) => s.cancelled).length;

	let polyline: string | null = null;
	if (detail.polylineCrd && detail.polylineCrd.length >= 4) {
		const dim = detail.polylineDim ?? 2;
		const raw = detail.polylineDelta
			? decodeDeltaCrd(detail.polylineCrd, dim)
			: detail.polylineCrd;
		const points: [number, number][] = [];
		for (let i = 0; i < raw.length; i += dim) {
			points.push([raw[i + 1] / 1_000_000, raw[i] / 1_000_000]);
		}
		polyline = JSON.stringify(points);
	}

	return {
		journeyRef: ref,
		dayOfOperation: detail.dayOfOperation ?? dayOfOperation,
		line,
		category: detail.product?.catOut ?? null,
		operator: detail.product?.operator ?? null,
		lineId: null,
		originStopId: origin.extId,
		originName: origin.name,
		originDepTime: origin.depTime,
		destStopId: dest.extId,
		destName: dest.name,
		destArrTime: dest.arrTime,
		status: detail.status ?? "P",
		cancelled: Math.max(detail.cancelled ? 1 : 0, existing.cancelled),
		partCancelled: Number(detail.partCancelled || cancelledStops > 0),
		cancelledStopCount: cancelledStops,
		totalStopCount: stops.length,
		wasTracked: existing.wasTracked,
		polyline,
		snapshotAt,
	};
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

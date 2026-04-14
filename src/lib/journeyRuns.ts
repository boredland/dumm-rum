import { and, count, eq, getTableColumns, isNotNull, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { excluded } from "../db/helpers";
import { departures, journeyRuns } from "../db/schema";
import { createHafasClient } from "./hafas";
import type { components } from "./hafas-types";

type JourneyDetail = components["schemas"]["JourneyDetail"];
type JourneyRunRow = typeof journeyRuns.$inferInsert;

interface DepStats {
	cancelledCount: number;
	depCount: number;
	trackedCount: number;
}

const FETCH_BATCH = 10;

/**
 * Pull distinct journey refs for a date and snapshot their route
 * topology from /journeyDetail + operational outcome from our own
 * departures table into `journey_runs`.
 *
 * RMV strips ALL operational metadata (cancellations, rt data, status)
 * from /journeyDetail overnight, so the /journeyDetail call only
 * provides route geometry (origin, dest, stop list). Cancellation and
 * tracking data is derived from our departures table which captured
 * the live flags during the day.
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

	// Derive operational data from our own departures (authoritative source).
	// RMV strips cancellation flags from /journeyDetail overnight.
	const depStatsRows = await db
		.select({
			ref: departures.journeyRef,
			cancelledCount: sql<number>`SUM(${departures.cancelled})`.as(
				"cancelled_count",
			),
			depCount: count().as("dep_count"),
			trackedCount:
				sql<number>`SUM(CASE WHEN ${departures.rtTime} IS NOT NULL THEN 1 ELSE 0 END)`.as(
					"tracked_count",
				),
		})
		.from(departures)
		.where(and(eq(departures.date, date), isNotNull(departures.journeyRef)))
		.groupBy(departures.journeyRef);

	const depStats = new Map<string, DepStats>();
	for (const row of depStatsRows) {
		if (row.ref)
			depStats.set(row.ref, {
				cancelledCount: row.cancelledCount,
				depCount: row.depCount,
				trackedCount: row.trackedCount,
			});
	}

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
			const stats = depStats.get(ref) ?? {
				cancelledCount: 0,
				depCount: 0,
				trackedCount: 0,
			};
			const row = buildRow(
				ref,
				result.data as JourneyDetail,
				stats,
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
						wasTracked: sql`MAX(${journeyRuns.wasTracked}, ${excluded(journeyRuns.wasTracked)})`,
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
	stats: DepStats,
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

	// Cancellation data from /journeyDetail is unreliable (RMV strips it
	// overnight). Use our departures table as source of truth instead.
	// Note: this only covers stops at tracked stations, not the full route.
	const { cancelledCount, depCount, trackedCount } = stats;

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
		cancelled: depCount > 0 && cancelledCount === depCount ? 1 : 0,
		partCancelled: cancelledCount > 0 ? 1 : 0,
		cancelledStopCount: cancelledCount,
		totalStopCount: stops.length,
		wasTracked: trackedCount > 0 ? 1 : 0,
		snapshotAt,
	};
}

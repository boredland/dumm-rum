import { count, eq, sql } from "drizzle-orm";
import { db } from "../db/client.ts";
import { journeyRuns } from "../db/schema.ts";
import { todayBerlin } from "./utils.ts";

export interface DienststandData {
	trackedToday: number;
	/** ISO timestamp of the most recent journey_run upsert. Null while the
	 * table is empty (fresh deploy, empty DB). */
	lastSnapshot: string | null;
}

export async function loadDienststand(): Promise<DienststandData> {
	const today = todayBerlin();
	const [row] = await db
		.select({
			tracked: count(),
			lastSnapshot: sql<string | null>`MAX(${journeyRuns.snapshotAt})`,
		})
		.from(journeyRuns)
		.where(eq(journeyRuns.dayOfOperation, today));

	return {
		trackedToday: Number(row?.tracked ?? 0),
		lastSnapshot: row?.lastSnapshot ?? null,
	};
}

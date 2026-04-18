import {
	type DaysFilter,
	getLineSummaries,
	getOldestDate,
	getOperatorSummaries,
	getStopSummaries,
	type LineSummary,
	type OperatorSummary,
	type StopSummary,
} from "./queries.ts";

export interface HomePayload {
	lines: LineSummary[];
	operators: OperatorSummary[];
	stops: StopSummary[];
	days: DaysFilter;
	oldestDate: string | null;
}

interface HomeEntry {
	value: HomePayload;
	fresh: number;
	stale: number;
}

/** Stop-summaries aggregation runs ~1 s locally and ~5–7 s on prod
 * (joins 7 days of journey_stops against journey_runs). Fresh window is
 * kept tight so toggling between day filters feels live; stale window
 * is long enough to absorb a cold-cache day without anyone ever hitting
 * the slow path synchronously. */
const HOME_FRESH_MS = 60_000;
const HOME_STALE_MS = 15 * 60_000;
const homeMemo = new Map<DaysFilter, HomeEntry>();
const homeInflight = new Map<DaysFilter, Promise<HomePayload>>();

async function fetchHomePayload(days: DaysFilter): Promise<HomePayload> {
	const filter = { days };
	const [lines, operators, stops, oldestDate] = await Promise.all([
		getLineSummaries(filter),
		getOperatorSummaries(filter),
		getStopSummaries(),
		getOldestDate(),
	]);
	return { lines, operators, stops, days, oldestDate };
}

function refreshHome(days: DaysFilter): Promise<HomePayload> {
	const existing = homeInflight.get(days);
	if (existing) return existing;
	const p = fetchHomePayload(days)
		.then((value) => {
			const now = Date.now();
			homeMemo.set(days, {
				value,
				fresh: now + HOME_FRESH_MS,
				stale: now + HOME_STALE_MS,
			});
			homeInflight.delete(days);
			return value;
		})
		.catch((e) => {
			homeInflight.delete(days);
			throw e;
		});
	homeInflight.set(days, p);
	return p;
}

export async function loadHomeSummaries(
	days: DaysFilter,
): Promise<HomePayload> {
	const now = Date.now();
	const hit = homeMemo.get(days);
	if (hit && hit.fresh > now) return hit.value;
	if (hit && hit.stale > now) {
		refreshHome(days).catch(() => {});
		return hit.value;
	}
	return refreshHome(days);
}

/** Preload "today" summaries at server startup so the first user after
 * a deploy lands on a warm memo instead of paying the 5–7 s DB cost. */
export function warmHomeSummaries(): Promise<HomePayload> {
	return refreshHome("today");
}

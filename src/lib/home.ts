import {
	type DaysFilter,
	getLineSummaries,
	getOldestDate,
	getOperatorSummaries,
	getStopSummaries,
	type LineSummary,
	type OperatorSummary,
	type QueryFilter,
	type StopSummary,
} from "./queries.ts";
import { makeSwr } from "./swr.ts";
import { yesterdayBerlin } from "./utils.ts";

export interface HomePayload {
	lines: LineSummary[];
	operators: OperatorSummary[];
	stops: StopSummary[];
	days: DaysFilter;
	until?: string;
	oldestDate: string | null;
}

const homeSwr = makeSwr<HomePayload>(
	async (key: string) => {
		// Parse cache key format: "days:until"
		const [days, until] = key.split(":");
		const filter: QueryFilter = { days: days as DaysFilter };
		if (until) filter.until = until;

		const [lines, operators, stops, oldestDate] = await Promise.all([
			getLineSummaries(filter),
			getOperatorSummaries(filter),
			getStopSummaries(),
			getOldestDate(),
		]);
		return {
			lines,
			operators,
			stops,
			days: days as DaysFilter,
			until,
			oldestDate,
		};
	},
	{ freshMs: 60_000, staleMs: 15 * 60_000 },
);

export function loadHomeSummaries(
	days: DaysFilter,
	until?: string,
): Promise<HomePayload> {
	const key = until ? `${days}:${until}` : days;
	return homeSwr.get(key);
}

/** Preload the summaries the home page opens on, so the first user after
 * a deploy lands on a warm memo instead of paying the 5–7 s DB cost.
 *
 * Goes through loadHomeSummaries rather than refreshing a hand-written
 * key: the route pins every non-"today" window to yesterday for
 * cacheability, so the key it asks for is `all:<yesterday>`. Seeding a
 * bare `all` would warm a key nobody requests and leave the first visitor
 * waiting on the cold aggregate anyway. */
export function warmHomeSummaries(): Promise<HomePayload> {
	return loadHomeSummaries("all", yesterdayBerlin());
}

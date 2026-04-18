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
import { makeSwr } from "./swr.ts";

export interface HomePayload {
	lines: LineSummary[];
	operators: OperatorSummary[];
	stops: StopSummary[];
	days: DaysFilter;
	oldestDate: string | null;
}

const homeSwr = makeSwr<HomePayload>(
	async (days) => {
		const filter = { days: days as DaysFilter };
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
			oldestDate,
		};
	},
	{ freshMs: 60_000, staleMs: 15 * 60_000 },
);

export function loadHomeSummaries(days: DaysFilter): Promise<HomePayload> {
	return homeSwr.get(days);
}

/** Preload "today" summaries at server startup so the first user after
 * a deploy lands on a warm memo instead of paying the 5–7 s DB cost. */
export function warmHomeSummaries(): Promise<HomePayload> {
	return homeSwr.refresh("today");
}

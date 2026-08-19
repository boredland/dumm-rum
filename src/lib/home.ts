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
import { nowBerlin, yesterdayBerlin } from "./utils.ts";

export interface HomePayload {
	lines: LineSummary[];
	operators: OperatorSummary[];
	stops: StopSummary[];
	days: DaysFilter;
	until?: string;
	oldestDate: string | null;
}

/** Stop summaries and the oldest date are the same for every window — one
 * is a fixed 7-day rollup, the other a MIN over all runs. Held under their
 * own keys so four day-filters share one result instead of recomputing it
 * four times, and so a day-filter miss only pays for the queries that
 * actually depend on the filter. */
const sharedSwr = makeSwr<{
	stops: StopSummary[];
	oldestDate: string | null;
}>(
	async () => {
		const [stops, oldestDate] = await Promise.all([
			getStopSummaries(),
			getOldestDate(),
		]);
		return { stops, oldestDate };
	},
	{ freshMs: 60_000, staleMs: 15 * 60_000 },
);

const homeSwr = makeSwr<HomePayload>(
	async (key: string) => {
		// Parse cache key format: "days:until"
		const [days, until] = key.split(":");
		const filter: QueryFilter = { days: days as DaysFilter };
		if (until) filter.until = until;

		const [lines, operators, shared] = await Promise.all([
			getLineSummaries(filter),
			getOperatorSummaries(filter),
			sharedSwr.get("shared"),
		]);
		const { stops, oldestDate } = shared;
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

/** Every window the day toggle can ask for. The toggle re-runs the route
 * loader, so each one is its own memo key and each uncovered key costs a
 * visitor the full aggregate — measured at 9.9 s against production for a
 * cold `weekends` against 0.08 s once warm. Warming only `all` left the
 * other three to be paid for by whoever clicked them first. */
const WARMED_DAYS: DaysFilter[] = ["all", "weekdays", "weekends", "today"];

/** Preload the summaries the home page opens on, so the first user after
 * a deploy lands on a warm memo instead of paying the 5–7 s DB cost.
 *
 * Goes through loadHomeSummaries rather than refreshing a hand-written
 * key: the route pins every non-"today" window to yesterday for
 * cacheability, so the key it asks for is `<days>:<yesterday>`. Seeding a
 * bare `all` would warm a key nobody requests and leave the first visitor
 * waiting on the cold aggregate anyway.
 *
 * Sequential on purpose. These are the heaviest aggregates the site runs
 * and the point is to fill a cache in the background, not to race the
 * first visitor for the connection pool. Failures are swallowed per key:
 * a warmup is an optimisation, and one bad window must not take the boot
 * down or stop the remaining windows from being warmed. */
export async function warmHomeSummaries(): Promise<void> {
	const until = yesterdayBerlin();
	for (const days of WARMED_DAYS) {
		try {
			await loadHomeSummaries(days, days === "today" ? undefined : until);
		} catch (e) {
			console.warn(`home warmup failed for days=${days}:`, e);
		}
	}
}

/** Clear of the rollover, so the refill cannot compute yesterday's date a
 * few milliseconds early and warm the keys the site is about to stop
 * asking for. */
const ROLLOVER_MARGIN_MS = 60_000;

function msUntilNextBerlinMidnight(): number {
	const now = nowBerlin();
	return now.add(1, "day").startOf("day").diff(now) + ROLLOVER_MARGIN_MS;
}

/** Warms the memos now and again after every Berlin midnight.
 *
 * Both parts are needed. Every non-"today" key is pinned to
 * `yesterdayBerlin()` for cacheability, so at 00:00 Berlin the whole set
 * the boot warmup filled becomes unreachable and the site is as cold as it
 * is right after a deploy — which is why the landing page went slow again
 * each day rather than once per release.
 *
 * Re-armed from the wall clock each night rather than on a fixed 24 h
 * interval, so a DST change moves the refill with the date boundary
 * instead of drifting an hour off it. */
export async function startHomeWarmup(): Promise<void> {
	await warmHomeSummaries();

	const arm = (): void => {
		const timer = setTimeout(() => {
			warmHomeSummaries()
				.catch((e) => console.warn("home warmup failed:", e))
				.finally(arm);
		}, msUntilNextBerlinMidnight());
		// A pending refill is no reason to keep the process alive on shutdown.
		timer.unref?.();
	};
	arm();
}

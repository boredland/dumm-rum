import dayjs from "dayjs";
import timezone from "dayjs/plugin/timezone.js";
import utc from "dayjs/plugin/utc.js";

dayjs.extend(utc);
dayjs.extend(timezone);

const TZ = "Europe/Berlin";

export function nowBerlin() {
	return dayjs().tz(TZ);
}

export function berlinTime(date: string, time: string) {
	return dayjs.tz(`${date}T${time}`, TZ);
}

export function todayBerlin(): string {
	return nowBerlin().format("YYYY-MM-DD");
}

export function yesterdayBerlin(): string {
	return nowBerlin().subtract(1, "day").format("YYYY-MM-DD");
}

/** Minutes after which a departure counts as "delayed". Drives both the
 * `delay_min` generated column's partial index and every query filter, so
 * changing it means regenerating that index. */
export const DELAY_THRESHOLD_MIN = 7.5;

export function pct(numer: number, denom: number): string {
	return denom > 0 ? ((numer / denom) * 100).toFixed(1) : "0.0";
}

export function onTimeRate(
	cancelled: number,
	delayed: number,
	total: number,
): number {
	if (total === 0) return 100;
	return Math.round(((total - cancelled - delayed) / total) * 100);
}

export function formatTime(time: string | null): string {
	if (!time) return "—";
	return time.slice(0, 5);
}

/** Minutes a departure ran late, or null without a real-time pair.
 *
 * Takes clock times only, mirroring the `delay_minutes` SQL function behind
 * `journey_stops.delay_min`,
 * including the midnight correction: the two values carry a clock but no date,
 * so 23:55 -> 00:05 would otherwise read as -1430 rather than +10. Anything
 * past ±12 h is a wrap, not a figure. HAFAS also emits an over-24 h clock
 * (24:05) for the same instant, which `Date` rejects, so the hours are parsed
 * rather than delegated to it. */
export function delayMin(sched: string, rt: string | null): number | null {
	if (!rt) return null;
	const planned = minutesOfDay(sched);
	const actual = minutesOfDay(rt);
	if (planned === null || actual === null) return null;
	const diff = actual - planned;
	if (diff < -720) return Math.round(diff + 1440);
	if (diff > 720) return Math.round(diff - 1440);
	return Math.round(diff);
}

/** `HH:MM[:SS]` as minutes past midnight. Hours may exceed 24 — HAFAS uses
 * 24:05 for the small hours of the following service day. */
function minutesOfDay(time: string): number | null {
	const [h, m, s] = time.split(":");
	const hours = Number(h);
	const minutes = Number(m);
	const seconds = s === undefined ? 0 : Number(s);
	if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null;
	if (!Number.isFinite(seconds)) return null;
	return hours * 60 + minutes + seconds / 60;
}

/** Long-form date for the per-day pages. Shared because the page heading
 * and the document title have to name the same day the same way. */
export function prettyDate(lang: string, date: string): string {
	return new Date(`${date}T00:00:00`).toLocaleDateString(lang, {
		weekday: "long",
		year: "numeric",
		month: "long",
		day: "numeric",
	});
}

export function shortStationName(name: string): string {
	return name
		.replace(/^Frankfurt \(Main\)\s*/i, "FFM ")
		.replace(/Hauptbahnhof/g, "Hbf");
}

export function parseLineSlug(slug: string): {
	line: string;
	category: string | null;
	source: string | null;
} {
	const parts = slug.split(":");
	if (parts.length === 3) {
		return { source: parts[0], category: parts[1], line: parts[2] };
	}
	if (parts.length === 2) {
		return { source: null, category: parts[0], line: parts[1] };
	}
	return { source: null, category: null, line: slug };
}

export function providerFromRef(ref: string): string {
	if (/^[12]\|/.test(ref)) return "rmv";
	return "unknown";
}

export function lineSlug(
	source: string,
	category: string | null,
	line: string,
): string {
	return `${source}:${category ?? "Bus"}:${line}`;
}

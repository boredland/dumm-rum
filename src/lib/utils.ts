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

// Stats thresholds. Planned frequency is the assumed wait between
// departures — used as the "wait time" contribution when a departure is
// cancelled, so avg_delay for a 100%-cancelled day isn't NaN. Delay
// threshold is the minutes after which a departure counts as "delayed".
export const PLANNED_FREQUENCY_MIN = 15;
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

export function delayMin(
	date: string,
	sched: string,
	rt: string | null,
): number | null {
	if (!rt) return null;
	const planned = new Date(`${date}T${sched}`).getTime();
	const actual = new Date(`${date}T${rt}`).getTime();
	if (!Number.isFinite(planned) || !Number.isFinite(actual)) return null;
	return Math.round((actual - planned) / 60_000);
}

export function shortStationName(name: string): string {
	return name
		.replace(/^Frankfurt \(Main\)\s*/i, "FFM ")
		.replace(/Hauptbahnhof/g, "Hbf");
}

export function parseLineSlug(slug: string): {
	line: string;
	category: string | null;
} {
	if (slug.includes(":")) {
		const [category, ...rest] = slug.split(":");
		return { category, line: rest.join(":") };
	}
	return { category: null, line: slug };
}

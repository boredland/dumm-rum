import dayjs from "dayjs";
import timezone from "dayjs/plugin/timezone";
import utc from "dayjs/plugin/utc";

dayjs.extend(utc);
dayjs.extend(timezone);

const TZ = "Europe/Berlin";

export function nowBerlin() {
	return dayjs().tz(TZ);
}

export function todayBerlin(): string {
	return nowBerlin().format("YYYY-MM-DD");
}

export function pct(cancelled: number, total: number): string {
	return total > 0 ? ((cancelled / total) * 100).toFixed(1) : "0.0";
}

export function fmtDelay(delay: number | null): string {
	if (delay === null) return "\u2014";
	return `${delay >= 0 ? "+" : ""}${delay.toFixed(1)} min`;
}

export function fmtTimestamp(iso: string | null, lang = "de"): string {
	if (!iso) return "";
	return new Date(iso).toLocaleString(lang, {
		timeZone: TZ,
		day: "2-digit",
		month: "2-digit",
		year: "numeric",
		hour: "2-digit",
		minute: "2-digit",
	});
}

export function fmtDate(date: string, lang = "de"): string {
	return new Date(`${date}T00:00:00`).toLocaleDateString(lang, {
		day: "2-digit",
		month: "2-digit",
		year: "numeric",
	});
}

export function delayMinutes(
	date: string,
	time: string,
	rtDate: string,
	rtTime: string,
): number {
	return (
		(new Date(`${rtDate}T${rtTime}`).getTime() -
			new Date(`${date}T${time}`).getTime()) /
		60000
	);
}

export function onTimeRate(
	cancelled: number,
	delayed: number,
	total: number,
): number {
	if (total === 0) return 100;
	return Math.round(((total - cancelled - delayed) / total) * 100);
}

export function trendArrow(
	current: { cancelled: number; delayed: number; total: number },
	prev: { cancelled: number; delayed: number; total: number },
): string {
	if (prev.total === 0 || current.total === 0) return "";
	const currentIssues = (current.cancelled + current.delayed) / current.total;
	const prevIssues = (prev.cancelled + prev.delayed) / prev.total;
	const diff = currentIssues - prevIssues;
	if (Math.abs(diff) < 0.005) return "";
	return diff > 0 ? "\u2191" : "\u2193";
}

export function trendColor(arrow: string): string {
	if (arrow === "\u2191") return "text-danger";
	if (arrow === "\u2193") return "text-success";
	return "";
}

export function shortStationName(name: string): string {
	return name
		.replace(/^Frankfurt \(Main\)\s*/i, "FFM ")
		.replace(/Hauptbahnhof/g, "Hbf");
}

export const PLANNED_FREQUENCY_MIN = 15;
export const DELAY_THRESHOLD_MIN = 7.5;

export function scoreBorderColor(otp: number): string {
	return otp < 80
		? "border-danger"
		: otp < 90
			? "border-warning"
			: "border-success";
}

export function scoreBgColor(otp: number): string {
	return otp < 80 ? "bg-danger" : otp < 90 ? "bg-warning" : "bg-success";
}

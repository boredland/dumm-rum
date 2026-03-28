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

export function shortDir(dir: string): string {
	return dir.replace(/^Frankfurt \(Main\)\s*/i, "");
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

export function reliabilityScore(
	cancelled: number,
	delayed: number,
	total: number,
	avgDelay: number | null,
): number {
	if (total === 0) return 100;
	const cancelRate = (cancelled / total) * 100;
	const delayedRate = (delayed / total) * 100;
	const delayPenalty = Math.min((avgDelay ?? 0) / 10, 10);
	return Math.max(
		0,
		Math.min(
			100,
			Math.round(100 - cancelRate * 4 - delayedRate * 3.5 - delayPenalty * 2.5),
		),
	);
}

export function trendArrow(
	current: { cancelled: number; total: number },
	prev: { cancelled: number; total: number },
): string {
	if (prev.total === 0 || current.total === 0) return "";
	const currentRate = current.cancelled / current.total;
	const prevRate = prev.cancelled / prev.total;
	const diff = currentRate - prevRate;
	if (Math.abs(diff) < 0.005) return "";
	return diff > 0 ? "\u2191" : "\u2193";
}

export function trendColor(arrow: string): string {
	if (arrow === "\u2191") return "text-danger";
	if (arrow === "\u2193") return "text-success";
	return "";
}

export function scoreBorderColor(score: number): string {
	return score <= 85
		? "border-danger"
		: score <= 93
			? "border-warning"
			: "border-success";
}

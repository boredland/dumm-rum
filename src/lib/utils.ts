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

export function rateBorderColor(cancelled: number, total: number): string {
	const rate = total > 0 ? (cancelled / total) * 100 : 0;
	return rate >= 2
		? "border-danger"
		: rate >= 1
			? "border-warning"
			: "border-success";
}

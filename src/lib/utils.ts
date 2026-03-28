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

export function fmtFreq(freq: number | null): string {
	return freq !== null ? `~${freq.toFixed(0)} min` : "\u2014";
}

export function fmtDelay(delay: number | null): string {
	if (delay === null) return "\u2014";
	return `${delay >= 0 ? "+" : ""}${delay.toFixed(1)} min`;
}

export function shortDir(dir: string): string {
	return dir.replace(/^Frankfurt \(Main\)\s*/i, "");
}

export function fmtTimestamp(iso: string | null): string {
	if (!iso) return "";
	return dayjs(iso).tz(TZ).format("DD.MM.YYYY, HH:mm");
}

export function timeToMinutes(t: string): number {
	const [h, m] = t.split(":").map(Number);
	return h * 60 + m;
}

export function rateBorderColor(cancelled: number, total: number): string {
	const rate = total > 0 ? (cancelled / total) * 100 : 0;
	return rate >= 5
		? "border-danger"
		: rate >= 1
			? "border-warning"
			: "border-success";
}

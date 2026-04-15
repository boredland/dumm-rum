import dayjs from "dayjs";
import timezone from "dayjs/plugin/timezone";
import utc from "dayjs/plugin/utc";

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

export function pickKey(apiKeys: string): string {
	const keys = apiKeys
		.split(",")
		.map((k) => k.trim())
		.filter(Boolean);
	return keys[Math.floor(Math.random() * keys.length)];
}

export function extractPolyline(detail: {
	PolylineGroup?: {
		polylineDesc?: { crd?: number[]; dim?: number; delta?: boolean }[];
	};
}): string | null {
	const polyDesc = detail.PolylineGroup?.polylineDesc?.[0];
	const polyCrd = polyDesc?.crd;
	const dim = polyDesc?.dim ?? 2;
	if (!polyCrd || polyCrd.length < dim * 2) return null;

	const raw = polyDesc.delta ? decodeDeltaCrd(polyCrd, dim) : polyCrd;
	// HAFAS serializes WGS84 as integers scaled by 1e6; detect by magnitude
	// so we don't re-scale already-degree values.
	const scale = Math.abs(raw[0]) > 1000 ? 1_000_000 : 1;
	const points: [number, number][] = [];
	for (let i = 0; i < raw.length; i += dim) {
		points.push([raw[i + 1] / scale, raw[i] / scale]);
	}
	return JSON.stringify(points);
}

function decodeDeltaCrd(encoded: number[], dim: number): number[] {
	const result: number[] = [];
	const acc = new Array(dim).fill(0);
	for (let i = 0; i < encoded.length; i += dim) {
		for (let d = 0; d < dim; d++) {
			acc[d] += encoded[i + d];
			result.push(acc[d]);
		}
	}
	return result;
}

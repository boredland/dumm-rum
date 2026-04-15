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

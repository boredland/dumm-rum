/**
 * Pure weekday parsing, formatting, and expansion helpers used by the
 * Telegram bot subscription commands (see `src/lib/telegram.ts`).
 *
 * Kept in a standalone DB-free module so they can be imported and tested
 * without requiring a DATABASE_URL connection.
 */

export const WEEKDAY_NAMES: Record<string, number> = {
	mo: 1,
	mon: 1,
	di: 2,
	tue: 2,
	mi: 3,
	wed: 3,
	do: 4,
	thu: 4,
	fr: 5,
	fri: 5,
	sa: 6,
	sat: 6,
	so: 0,
	sun: 0,
};

const DAY_NAMES = ["So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"];

/** Days from `from` to `to` inclusive, wrapping through Sunday.
 *
 * Counted rather than stopped on a sentinel: an `i !== (to + 1) % 7` guard is
 * already true on the first iteration when the range covers all seven days, so
 * `Mo-So` used to yield Sunday alone and silence six days of alerts. */
export function expandRange(from: number, to: number): number[] {
	const span = ((to - from + 7) % 7) + 1;
	return Array.from({ length: span }, (_, i) => (from + i) % 7);
}

export function parseWeekdays(input: string): string | null {
	const days: number[] = [];
	for (const part of input.split(",")) {
		const trimmed = part.trim().toLowerCase();
		const rangeParts = trimmed.split("-");
		if (rangeParts.length === 2) {
			const from = WEEKDAY_NAMES[rangeParts[0]];
			const to = WEEKDAY_NAMES[rangeParts[1]];
			if (from === undefined || to === undefined) return null;
			days.push(...expandRange(from, to));
		} else {
			const n = WEEKDAY_NAMES[trimmed];
			if (n === undefined) return null;
			days.push(n);
		}
	}
	return [...new Set(days)].sort().join(",");
}

export function formatWeekdays(weekdays: string): string {
	return weekdays
		.split(",")
		.map((d) => DAY_NAMES[Number(d)])
		.join(", ");
}

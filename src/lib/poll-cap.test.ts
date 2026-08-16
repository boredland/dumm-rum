import { describe, expect, test } from "bun:test";
import { isHardCapReached } from "./poll-cap.ts";
import { nowBerlin } from "./utils.ts";

describe("isHardCapReached", () => {
	test("normal daytime run well in the future is not capped", () => {
		const future = nowBerlin().add(3, "hour");
		const futureDep = future.format("HH:mm:ss");
		const futureArr = future.add(30, "minute").format("HH:mm:ss");
		const futureDate = future.format("YYYY-MM-DD");
		expect(isHardCapReached(futureDep, futureArr, futureDate)).toBe(false);
	});

	test("returns false when arrival time is missing", () => {
		const today = nowBerlin().format("YYYY-MM-DD");
		expect(isHardCapReached("10:00:00", undefined, today)).toBe(false);
	});

	test("returns false when day of operation is missing", () => {
		expect(isHardCapReached("10:00:00", "10:40:00", undefined)).toBe(false);
	});

	test("HAFAS 24-hour form is not capped before departure", () => {
		const today = nowBerlin().format("YYYY-MM-DD");
		expect(isHardCapReached("23:45:00", "24:35:00", today)).toBe(false);
	});

	test("wrapped midnight arrival is not capped before departure", () => {
		const today = nowBerlin().format("YYYY-MM-DD");
		// A wrapped midnight arrival (e.g. 00:35 after 23:45) belongs to the
		// next calendar day, so it should not be capped before departure.
		expect(isHardCapReached("23:45:00", "00:35:00", today)).toBe(false);
	});

	test("genuinely finished overnight run is capped", () => {
		const twoDaysAgo = nowBerlin().subtract(2, "day").format("YYYY-MM-DD");
		expect(isHardCapReached("23:45:00", "00:35:00", twoDaysAgo)).toBe(true);
	});

	test("degenerate equal times in the past are capped", () => {
		const twoDaysAgo = nowBerlin().subtract(2, "day").format("YYYY-MM-DD");
		expect(isHardCapReached("10:00:00", "10:00:00", twoDaysAgo)).toBe(true);
	});
});

import { describe, expect, test } from "bun:test";
import { expandRange, parseWeekdays } from "./weekdays.ts";

function normalize(days: number[]): number[] {
	return [...new Set(days)].sort((a, b) => a - b);
}

describe("expandRange", () => {
	test("expands Monday to Friday range", () => {
		expect(normalize(expandRange(1, 5))).toEqual([1, 2, 3, 4, 5]);
	});

	test("expands Saturday to Sunday weekend range", () => {
		expect(normalize(expandRange(6, 0))).toEqual([0, 6]);
	});

	test("expands Friday to Monday wrapping range", () => {
		expect(normalize(expandRange(5, 1))).toEqual([0, 1, 5, 6]);
	});

	test("expands single-day range", () => {
		expect(normalize(expandRange(2, 2))).toEqual([2]);
	});

	test("expands Sunday to Saturday to the whole week", () => {
		expect(normalize(expandRange(0, 6))).toEqual([0, 1, 2, 3, 4, 5, 6]);
	});

	test("expands Monday to Sunday to the whole week", () => {
		expect(normalize(expandRange(1, 0))).toEqual([0, 1, 2, 3, 4, 5, 6]);
	});

	test("never repeats a day", () => {
		for (const [from, to] of [
			[1, 5],
			[0, 6],
			[1, 0],
			[6, 0],
			[5, 1],
			[2, 2],
		]) {
			const days = expandRange(from, to);
			expect(days.length).toBe(new Set(days).size);
		}
	});
});

describe("parseWeekdays", () => {
	test("parses comma-separated weekday abbreviations", () => {
		expect(parseWeekdays("Mo,Di")).toBe("1,2");
	});

	test("parses weekday range", () => {
		expect(parseWeekdays("Mo-Fr")).toBe("1,2,3,4,5");
	});

	test("returns null for invalid string", () => {
		expect(parseWeekdays("nonsense")).toBeNull();
	});

	test("returns null for range with invalid endpoint", () => {
		expect(parseWeekdays("Mo-Xx")).toBeNull();
	});

	test("expands a full-week range to every day", () => {
		expect(parseWeekdays("Mo-So")).toBe("0,1,2,3,4,5,6");
	});
});

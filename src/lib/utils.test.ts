import { describe, expect, test } from "bun:test";
import {
	delayMin,
	formatTime,
	lineSlug,
	onTimeRate,
	parseLineSlug,
} from "./utils.ts";

describe("onTimeRate", () => {
	test("returns 100 when total is 0", () => {
		expect(onTimeRate(0, 0, 0)).toBe(100);
	});

	test("returns 100 when there are no cancellations or delays", () => {
		expect(onTimeRate(0, 0, 100)).toBe(100);
	});

	test("calculates on-time percentage correctly", () => {
		expect(onTimeRate(10, 10, 100)).toBe(80);
	});

	test("returns 0 when all trips are cancelled or delayed", () => {
		expect(onTimeRate(50, 50, 100)).toBe(0);
	});
});

describe("formatTime", () => {
	test("formats null as em dash", () => {
		expect(formatTime(null)).toBe("—");
	});

	test("formats empty string as em dash", () => {
		expect(formatTime("")).toBe("—");
	});

	test("truncates seconds from time string", () => {
		expect(formatTime("08:30:00")).toBe("08:30");
	});
});

describe("delayMin", () => {
	test("returns null when realtime is null", () => {
		expect(delayMin("10:00:00", null)).toBeNull();
	});

	test("calculates positive delay in minutes", () => {
		expect(delayMin("10:00:00", "10:07:00")).toBe(7);
	});

	test("calculates negative delay when running early", () => {
		expect(delayMin("10:07:00", "10:00:00")).toBe(-7);
	});

	test("reads a departure that slips past midnight as late, not early", () => {
		expect(delayMin("23:55:00", "00:05:00")).toBe(10);
	});

	test("reads an early arrival across midnight as early", () => {
		expect(delayMin("00:05:00", "23:55:00")).toBe(-10);
	});

	test("accepts the HAFAS over-24h clock for the same instant", () => {
		expect(delayMin("23:55:00", "24:05:00")).toBe(10);
	});

	test("keeps a large real delay rather than folding it", () => {
		// 638 min is the largest genuine delay in the data; the ±12 h wrap
		// threshold has to stay clear of it.
		expect(delayMin("10:00:00", "20:38:00")).toBe(638);
	});

	test("recovers the shape of the rows this fixed", () => {
		// Real row: scheduled 23:59, arrived 01:00 the next morning.
		expect(delayMin("23:59:00", "01:00:00")).toBe(61);
	});
});

describe("parseLineSlug and lineSlug", () => {
	test("parses three-part slug", () => {
		expect(parseLineSlug("rmv:U-Bahn:U4")).toEqual({
			source: "rmv",
			category: "U-Bahn",
			line: "U4",
		});
	});

	test("parses two-part slug", () => {
		expect(parseLineSlug("Bus:30")).toEqual({
			source: null,
			category: "Bus",
			line: "30",
		});
	});

	test("parses single-part slug", () => {
		expect(parseLineSlug("U4")).toEqual({
			source: null,
			category: null,
			line: "U4",
		});
	});

	test("round trips via lineSlug and parseLineSlug", () => {
		expect(parseLineSlug(lineSlug("rmv", "Bus", "30"))).toEqual({
			source: "rmv",
			category: "Bus",
			line: "30",
		});
	});

	test("defaults null category to Bus in lineSlug", () => {
		expect(lineSlug("rmv", null, "30")).toBe("rmv:Bus:30");
	});
});

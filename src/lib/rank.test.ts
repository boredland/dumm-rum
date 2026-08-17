import { describe, expect, test } from "bun:test";
import { meanOnTimeRate, onTimeRate, rankScore } from "./utils.ts";

/** A network shaped like the real one: mostly decent high-volume service,
 * plus the rail-replacement stub that used to own the top of the page. */
const NETWORK = [
	{ name: "U4", cancelled: 2, delayed: 30, total: 1200 },
	{ name: "Bus 12", cancelled: 5, delayed: 60, total: 800 },
	{ name: "Bus 30", cancelled: 40, delayed: 160, total: 900 },
	{ name: "S1", cancelled: 30, delayed: 90, total: 600 },
	{ name: "SEV", cancelled: 0, delayed: 2, total: 3 },
];
const SEV = NETWORK[4];
const BUS30 = NETWORK[2];

describe("meanOnTimeRate", () => {
	test("weights by departures, not by entity", () => {
		const mean = meanOnTimeRate([
			{ cancelled: 0, delayed: 0, total: 999 },
			{ cancelled: 1, delayed: 0, total: 1 },
		]);
		expect(mean).toBeCloseTo(0.999, 5);
	});

	test("an empty set is fully on time, so it cannot drag a ranking", () => {
		expect(meanOnTimeRate([])).toBe(1);
	});
});

describe("rankScore", () => {
	const mean = meanOnTimeRate(NETWORK);
	const ranked = [...NETWORK].sort(
		(a, b) =>
			rankScore(a.cancelled, a.delayed, a.total, mean) -
			rankScore(b.cancelled, b.delayed, b.total, mean),
	);

	test("the thinnest sample no longer leads the worst-first ranking", () => {
		const byRaw = [...NETWORK].sort(
			(a, b) =>
				onTimeRate(a.cancelled, a.delayed, a.total) -
				onTimeRate(b.cancelled, b.delayed, b.total),
		);
		expect(byRaw[0].name).toBe("SEV");
		expect(ranked[0].name).not.toBe("SEV");
	});

	test("a sustained bad record outranks the thin sample", () => {
		expect(ranked.indexOf(BUS30)).toBeLessThan(ranked.indexOf(SEV));
	});

	test("a single observation sits near the mean, not at its raw rate", () => {
		const score = rankScore(1, 0, 1, 0.9);
		expect(score).toBeGreaterThan(0.8);
		expect(score).toBeLessThan(0.9);
	});

	test("converges on the raw rate as departures accumulate", () => {
		expect(rankScore(0, 2000, 10_000, 1)).toBeCloseTo(0.8, 2);
	});

	test("no departures scores exactly the mean", () => {
		expect(rankScore(0, 0, 0, 0.87)).toBeCloseTo(0.87, 10);
	});

	test("orders two equally-sampled lines by their actual records", () => {
		const worse = rankScore(10, 10, 100, 0.9);
		const better = rankScore(1, 1, 100, 0.9);
		expect(worse).toBeLessThan(better);
	});
});

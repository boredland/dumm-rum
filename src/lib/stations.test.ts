import { describe, expect, test } from "bun:test";
import { nameToSlug, STATIONS, slugForStop } from "./stations.ts";

describe("nameToSlug", () => {
	test("strips Frankfurt prefix and transliterates umlauts and esszett", () => {
		expect(nameToSlug("Frankfurt (Main) Höhenstraße")).toBe("hoehenstrasse");
		expect(nameToSlug("Frankfurt (Main) Südbahnhof")).toBe("suedbahnhof");
		expect(nameToSlug("Wiesbaden-Mainz-Kastel Bahnhof")).toBe(
			"wiesbaden-mainz-kastel-bahnhof",
		);
		expect(nameToSlug("Frankfurt (Main) Höchst Bahnhof")).toBe(
			"hoechst-bahnhof",
		);
	});

	test("strips special characters without leaving trailing hyphens", () => {
		expect(nameToSlug("Test Stop!")).toBe("test-stop");
	});
});

describe("slugForStop", () => {
	test("prefers curated slug when stop ID is known", () => {
		expect(slugForStop(["3000510"], "irrelevant name")).toBe("konstablerwache");
	});

	test("falls through to nameToSlug when stop ID is unknown", () => {
		expect(slugForStop(["9999999"], "Frankfurt (Main) Höhenstraße")).toBe(
			"hoehenstrasse",
		);
	});

	test("derives slug from name when stop IDs array is empty", () => {
		expect(slugForStop([], "Frankfurt (Main) Südbahnhof")).toBe("suedbahnhof");
	});

	test("matches curated slug for every configured station in STATIONS", () => {
		for (const station of STATIONS) {
			expect(slugForStop([station.id], station.name)).toBe(station.slug);
		}
	});
});

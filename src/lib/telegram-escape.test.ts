import { describe, expect, test } from "bun:test";
import { escapeHtml } from "./telegram-escape.ts";

describe("escapeHtml", () => {
	test("escapes less-than character", () => {
		expect(escapeHtml("U<4")).toBe("U&lt;4");
	});

	test("escapes ampersand character", () => {
		expect(escapeHtml("A & B")).toBe("A &amp; B");
	});

	test("escapes HTML tags", () => {
		expect(escapeHtml("<b>bold</b>")).toBe("&lt;b&gt;bold&lt;/b&gt;");
	});

	test("escapes ampersand first to avoid double-processing (ordering regression)", () => {
		expect(escapeHtml("&lt;")).toBe("&amp;lt;");
	});

	test("leaves ordinary German stop names unchanged", () => {
		expect(escapeHtml("Frankfurt (Main) Höchst")).toBe(
			"Frankfurt (Main) Höchst",
		);
	});

	test("handles empty string", () => {
		expect(escapeHtml("")).toBe("");
	});
});

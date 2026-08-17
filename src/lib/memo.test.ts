import { describe, expect, test } from "bun:test";
import { memoGet } from "./memo.ts";

describe("memoGet", () => {
	test("returns built body on cold key and coalesces concurrent calls", async () => {
		let callCount = 0;
		const builder = async () => {
			callCount++;
			return { message: "hello" };
		};

		const [res1, res2] = await Promise.all([
			memoGet("test:concurrent", 60, builder),
			memoGet("test:concurrent", 60, builder),
		]);

		expect(callCount).toBe(1);
		expect(res1).toBe(JSON.stringify({ message: "hello" }));
		expect(res2).toBe(JSON.stringify({ message: "hello" }));
	});

	test("does not re-run builder on warm key within TTL", async () => {
		let callCount = 0;
		const builder = async () => {
			callCount++;
			return { value: 42 };
		};

		const res1 = await memoGet("test:warm", 60, builder);
		const res2 = await memoGet("test:warm", 60, builder);

		expect(callCount).toBe(1);
		expect(res1).toBe(JSON.stringify({ value: 42 }));
		expect(res2).toBe(JSON.stringify({ value: 42 }));
	});

	test("evicts earliest entries when inserting over MAX_ENTRIES", async () => {
		const counts: Record<string, number> = {};
		const makeBuilder = (k: string) => async () => {
			counts[k] = (counts[k] ?? 0) + 1;
			return { k };
		};

		// 4096 is MAX_ENTRIES. Insert 4096 + 10 = 4106 distinct keys.
		const total = 4096 + 10;
		for (let i = 0; i < total; i++) {
			await memoGet(`cap:${i}`, 60, makeBuilder(`cap:${i}`));
		}

		// Initial inserts should all have called their builders once
		expect(counts["cap:0"]).toBe(1);
		expect(counts[`cap:${total - 1}`]).toBe(1);

		// Key 0 (inserted first) should have been evicted by the over-cap insertions
		await memoGet("cap:0", 60, makeBuilder("cap:0"));
		expect(counts["cap:0"]).toBe(2);

		// A recent key (e.g. total - 1) should still be in the memo and not re-run
		await memoGet(`cap:${total - 1}`, 60, makeBuilder(`cap:${total - 1}`));
		expect(counts[`cap:${total - 1}`]).toBe(1);
	});
});

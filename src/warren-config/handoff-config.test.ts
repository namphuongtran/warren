import { describe, expect, test } from "bun:test";
import { DefaultsConfigSchema } from "./schema.ts";

/** `handoff.required` (namphuongtran/warren#21): absent means flag-only. */
describe("DefaultsConfigSchema handoff block", () => {
	test("leaves handoff undefined when the block is omitted", () => {
		const parsed = DefaultsConfigSchema.safeParse({});
		expect(parsed.success && parsed.data.handoff).toBeUndefined();
	});

	test("defaults required to false on a bare block", () => {
		const parsed = DefaultsConfigSchema.safeParse({ handoff: {} });
		expect(parsed.success && parsed.data.handoff).toEqual({ required: false });
	});

	test("accepts required: true", () => {
		const parsed = DefaultsConfigSchema.safeParse({ handoff: { required: true } });
		expect(parsed.success && parsed.data.handoff).toEqual({ required: true });
	});

	test("rejects an unknown key", () => {
		const parsed = DefaultsConfigSchema.safeParse({ handoff: { mandatory: true } });
		expect(parsed.success).toBe(false);
	});
});

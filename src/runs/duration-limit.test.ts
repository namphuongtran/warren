import { describe, expect, test } from "bun:test";
import {
	readMaxDurationMinutes,
	resolveDurationLimitMs,
	resolveDurationOverride,
} from "./duration-limit.ts";

describe("resolveDurationOverride", () => {
	test("prefers the explicit dispatch override over every other source", () => {
		expect(
			resolveDurationOverride({
				overrideMinutes: 30,
				frontmatter: { maxDurationMinutes: 60 },
				projectDefaultMinutes: 90,
			}),
		).toBe(30);
	});

	test("leaves a declared agent limit in place instead of folding", () => {
		expect(
			resolveDurationOverride({
				frontmatter: { maxDurationMinutes: 60 },
				projectDefaultMinutes: 90,
			}),
		).toBe(undefined);
	});

	test("falls back to the project default when the agent declares no limit", () => {
		expect(resolveDurationOverride({ frontmatter: {}, projectDefaultMinutes: 90 })).toBe(90);
		expect(
			resolveDurationOverride({
				frontmatter: { maxDurationMinutes: null },
				projectDefaultMinutes: 90,
			}),
		).toBe(90);
	});

	test("folds nothing when no source declares a limit", () => {
		expect(resolveDurationOverride({ frontmatter: {} })).toBe(undefined);
	});

	test("keeps a malformed agent limit failing open — the project default must not paper over it", () => {
		expect(
			resolveDurationOverride({
				frontmatter: { maxDurationMinutes: "6O" },
				projectDefaultMinutes: 90,
			}),
		).toBe(undefined);
		expect(
			resolveDurationOverride({
				frontmatter: { maxDurationMinutes: -1 },
				projectDefaultMinutes: 90,
			}),
		).toBe(undefined);
	});
});

describe("readMaxDurationMinutes", () => {
	test("reads numeric and stringified limits", () => {
		expect(readMaxDurationMinutes({ maxDurationMinutes: 45 })).toBe(45);
		expect(readMaxDurationMinutes({ maxDurationMinutes: "45" })).toBe(45);
	});

	test("treats absent, non-positive, and unparseable values as no limit", () => {
		expect(readMaxDurationMinutes({})).toBe(null);
		expect(readMaxDurationMinutes({ maxDurationMinutes: 0 })).toBe(null);
		expect(readMaxDurationMinutes({ maxDurationMinutes: "soon" })).toBe(null);
	});
});

describe("resolveDurationLimitMs", () => {
	test("converts the frozen frontmatter limit to milliseconds", () => {
		expect(resolveDurationLimitMs({ frontmatter: { maxDurationMinutes: 2 } })).toBe(120_000);
		expect(resolveDurationLimitMs({ frontmatter: { maxDurationMinutes: 0.5 } })).toBe(30_000);
	});

	test("returns null for a missing limit or a malformed shape", () => {
		expect(resolveDurationLimitMs({ frontmatter: {} })).toBe(null);
		expect(resolveDurationLimitMs(null)).toBe(null);
		expect(resolveDurationLimitMs({ frontmatter: [] })).toBe(null);
		expect(resolveDurationLimitMs("x")).toBe(null);
	});
});

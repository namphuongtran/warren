import { describe, expect, test } from "bun:test";
import { observeQuota } from "../../runtime/adapters/index.ts";
import { claudeEvents } from "./quota-test-helpers.ts";

const RESETS_AT = 1795338600;

function observations(fixture: string) {
	return claudeEvents(fixture).flatMap((ev) => {
		const seen = observeQuota(ev);
		return seen === null ? [] : [seen];
	});
}

describe("observeQuota", () => {
	test("reads each claude rate_limit_event of a mid-run rejection in order", () => {
		const seen = observations("claude-code-quota-mid-run.jsonl");
		expect(seen[0]).toEqual({
			status: "allowed",
			utilization: 0.59,
			rateLimitType: "five_hour",
			resetsAt: RESETS_AT,
		});
		expect(seen.at(-1)).toEqual({
			status: "rejected",
			utilization: 1,
			rateLimitType: "five_hour",
			resetsAt: RESETS_AT,
		});
	});

	test("ignores every event that is not a rate_limit_event", () => {
		const events = claudeEvents("claude-code-quota-turn-one.jsonl");
		const seen = events.map((ev) => observeQuota(ev));
		expect(seen.filter((s) => s !== null)).toHaveLength(1);
	});

	test("refuses a rate_limit_event the agent printed itself", () => {
		const [rejected] = claudeEvents("claude-code-quota-turn-one.jsonl");
		if (rejected === undefined) throw new Error("fixture is empty");
		expect(observeQuota({ ...rejected, origin: "agent" })).toBeNull();
	});
});

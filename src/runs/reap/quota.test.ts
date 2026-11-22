import { describe, expect, test } from "bun:test";
import { detectQuotaExhausted } from "../../runtime/adapters/index.ts";
import { claudeEvents, withoutRejection, withResult } from "./quota-test-helpers.ts";

const RESETS_AT = 1795338600;

describe("detectQuotaExhausted", () => {
	test("recognizes a claude run rejected on its first turn", () => {
		expect(detectQuotaExhausted(claudeEvents("claude-code-quota-turn-one.jsonl"))).toEqual({
			httpStatus: 429,
			apiError: "usage_limit_reached",
			rateLimitType: "five_hour",
			resetsAt: RESETS_AT,
		});
	});

	test("recognizes a claude run rejected mid-run after earlier warnings", () => {
		expect(detectQuotaExhausted(claudeEvents("claude-code-quota-mid-run.jsonl"))).toEqual({
			httpStatus: 429,
			apiError: "usage_limit_reached",
			rateLimitType: "five_hour",
			resetsAt: RESETS_AT,
		});
	});

	test("ignores a result that is not an error", () => {
		const events = withResult(claudeEvents("claude-code-quota-turn-one.jsonl"), {
			is_error: false,
		});
		expect(detectQuotaExhausted(events)).toBeNull();
	});

	test("ignores error results with a 401 or 500 status", () => {
		const base = claudeEvents("claude-code-quota-turn-one.jsonl");
		for (const status of [401, 500]) {
			const events = withResult(base, {
				api_error_status: status,
				api_error_type: "api_error",
				api_error: "other",
			});
			expect(detectQuotaExhausted(events)).toBeNull();
		}
	});

	test("ignores a run whose rate-limit events only reach allowed_warning", () => {
		const warned = withoutRejection(claudeEvents("claude-code-quota-mid-run.jsonl"));
		expect(detectQuotaExhausted(withResult(warned, { is_error: false }))).toBeNull();
		const crashed = withResult(warned, { api_error_status: 500, api_error: "other" });
		expect(detectQuotaExhausted(crashed)).toBeNull();
	});

	test("recognizes usage_limit_reached without a 429 and without a rate-limit event", () => {
		const events = withResult(claudeEvents("claude-code-quota-turn-one.jsonl"), {
			api_error_status: null,
		}).filter((ev) => ev.kind !== "telemetry");
		expect(detectQuotaExhausted(events)).toEqual({
			httpStatus: null,
			apiError: "usage_limit_reached",
			rateLimitType: null,
			resetsAt: null,
		});
	});

	test("refuses agent-authored envelopes", () => {
		const events = claudeEvents("claude-code-quota-turn-one.jsonl").map((ev) => ({
			...ev,
			origin: "agent",
		}));
		expect(detectQuotaExhausted(events)).toBeNull();
	});
});

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { detectClaudeQuotaExhaustion } from "../../runtime/adapters/parsers/claude-quota.ts";
import type { QuotaScanEvent } from "../../runtime/adapters/types.ts";
import { reapRun } from "./index.ts";
import {
	type Ctx,
	fakeBurrowClient,
	fakeExec,
	fakeFs,
	makeBurrow,
	reapDeps,
	setup,
} from "./test-helpers.ts";

/** Envelopes trimmed from run_cwchf800kdym / run_jy2cxd7cmg9f (issue #74). */
const RESETS_AT = 1795338600;

function rateLimit(status: string): QuotaScanEvent {
	return {
		kind: "telemetry",
		stream: "system",
		payload: {
			type: "rate_limit_event",
			rate_limit_info: { status, rateLimitType: "five_hour", resetsAt: RESETS_AT },
		},
	};
}

function result(over: Record<string, unknown> = {}): QuotaScanEvent {
	return {
		kind: "state_change",
		stream: "system",
		payload: {
			type: "result",
			subtype: "success",
			is_error: true,
			api_error_status: 429,
			api_error_type: "rate_limit_error",
			api_error: "usage_limit_reached",
			result: "You've hit your 5-hour limit · resets 9:10am (UTC)",
			...over,
		},
	};
}

describe("detectClaudeQuotaExhaustion", () => {
	test("reads the limit type and reset from the rejected rate_limit_event", () => {
		expect(
			detectClaudeQuotaExhaustion([rateLimit("allowed_warning"), rateLimit("rejected"), result()]),
		).toEqual({
			httpStatus: 429,
			apiError: "usage_limit_reached",
			rateLimitType: "five_hour",
			resetsAt: RESETS_AT,
		});
	});

	test("matches on api_error alone", () => {
		const signal = detectClaudeQuotaExhaustion([
			result({ api_error_status: undefined, api_error: "usage_limit_reached" }),
		]);
		expect(signal?.resetsAt).toBeNull();
		expect(signal?.apiError).toBe("usage_limit_reached");
	});

	test("is_error false is not quota exhaustion", () => {
		expect(detectClaudeQuotaExhaustion([result({ is_error: false })])).toBeNull();
	});

	test.each([401, 500])("api_error_status %p is not quota exhaustion", (status) => {
		expect(
			detectClaudeQuotaExhaustion([
				rateLimit("rejected"),
				result({ api_error_status: status, api_error: "other" }),
			]),
		).toBeNull();
	});

	test("allowed_warning events alone never qualify", () => {
		expect(detectClaudeQuotaExhaustion([rateLimit("allowed_warning")])).toBeNull();
	});

	test("agent-authored lines carry no authority", () => {
		expect(detectClaudeQuotaExhaustion([{ ...result(), origin: "agent" }])).toBeNull();
	});
});

describe("reapRun quota exhaustion (issue #74)", () => {
	let ctx: Ctx;
	beforeEach(async () => {
		ctx = await setup();
	});
	afterEach(async () => {
		await ctx.db.close();
	});

	async function seed(events: QuotaScanEvent[], withTurn: boolean) {
		let seq = 1;
		const all: QuotaScanEvent[] = withTurn
			? [{ kind: "text", stream: "stdout", payload: { text: "working" } }, ...events]
			: events;
		for (const ev of all) {
			await ctx.repos.events.append({
				runId: ctx.runId,
				sandboxEventSeq: seq++,
				ts: new Date().toISOString(),
				kind: ev.kind,
				stream: (ev.stream ?? "system") as "stdout" | "system",
				payload: ev.payload,
			});
		}
	}

	const fs = fakeFs();
	async function reap(outcome: "failed" | "succeeded" = "failed") {
		return reapRun({
			runId: ctx.runId,
			outcome,
			repos: ctx.repos,
			broker: ctx.broker,
			...reapDeps(fakeBurrowClient(makeBurrow()), { fs: fs.fs, exec: fakeExec().exec }),
			fs: fs.fs,
			exec: fakeExec().exec,
		});
	}

	test.each([false, true])("reaps failed/quota_exhausted (model turn seen: %p)", async (turn) => {
		await seed([rateLimit("rejected"), result()], turn);
		const reaped = await reap();
		expect(reaped.state).toBe("failed");
		expect(reaped.failureReason).toBe("quota_exhausted");
		const events = await ctx.repos.events.listByRun(ctx.runId);
		expect(events.find((e) => e.kind === "reap.quota_exhausted")?.payloadJson).toMatchObject({
			httpStatus: 429,
			apiError: "usage_limit_reached",
			rateLimitType: "five_hour",
			resetsAt: RESETS_AT,
		});
	});

	test("an is_error:false result keeps today's outcome", async () => {
		await seed([result({ is_error: false })], true);
		const reaped = await reap("succeeded");
		expect(reaped.failureReason).not.toBe("quota_exhausted");
	});
});

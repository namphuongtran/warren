import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { EventEnvelopeInput } from "../../core/event-envelope.ts";
import type { RunFailureReason, RunTerminalState } from "../../db/schema.ts";
import { listProviderQuota } from "../quota/state.ts";
import { reapRun } from "./index.ts";
import { claudeEvents, withoutRejection, withResult } from "./quota-test-helpers.ts";
import {
	type Ctx,
	fakeBurrowClient,
	fakeExec,
	fakeFs,
	makeBurrow,
	reapDeps,
	setup,
} from "./test-helpers.ts";

/**
 * End-to-end reapRun coverage for claude runs that hit the subscription usage
 * limit (namphuongtran/warren#74). The recognizer itself is covered in
 * `quota.test.ts`; these pin the failure reason, the event, and precedence.
 */
describe("reapRun quota exhaustion", () => {
	let ctx: Ctx;

	beforeEach(async () => {
		ctx = await setup();
		const { projectId } = await ctx.repos.runs.require(ctx.runId);
		if (projectId === null) throw new Error("setup() always creates a project");
		const run = await ctx.repos.runs.create({
			agentName: "refactor-bot",
			projectId,
			prompt: "p",
			renderedAgentJson: {},
			trigger: "manual",
			sandboxId: "bur_bbbbbbbbbbbb",
			sandboxRunId: "run_yyyyyyyyyyyy",
			provider: "anthropic",
			model: "claude-sonnet-5-5",
		});
		await ctx.repos.runs.markRunning(run.id);
		ctx = { ...ctx, runId: run.id };
	});

	afterEach(async () => {
		await ctx.db.close();
	});

	async function record(events: readonly EventEnvelopeInput[]): Promise<void> {
		let seq = 0;
		for (const ev of events) {
			seq += 1;
			await ctx.repos.events.append({
				runId: ctx.runId,
				sandboxEventSeq: seq,
				ts: new Date().toISOString(),
				kind: ev.kind,
				stream: ev.stream === "stdout" || ev.stream === "stderr" ? ev.stream : "system",
				payload: ev.payload,
			});
		}
	}

	async function reap(
		outcome: RunTerminalState,
		opts: { revListCount?: string; failureReason?: RunFailureReason } = {},
	) {
		const fs = fakeFs().fs;
		const exec = fakeExec({ revListCount: opts.revListCount ?? "0" }).exec;
		return reapRun({
			runId: ctx.runId,
			outcome,
			...(opts.failureReason !== undefined ? { failureReason: opts.failureReason } : {}),
			repos: ctx.repos,
			...reapDeps(fakeBurrowClient(makeBurrow()), { fs, exec }),
			broker: ctx.broker,
		});
	}

	test("reaps a run rejected on turn one as quota_exhausted", async () => {
		await record(claudeEvents("claude-code-quota-turn-one.jsonl"));

		const result = await reap("failed");

		expect(result.state).toBe("failed");
		expect(result.failureReason).toBe("quota_exhausted");
		expect(result.providerError).toBeNull();
		const events = await ctx.repos.events.listByRun(ctx.runId);
		expect(events.find((ev) => ev.kind === "reap.quota_exhausted")?.payloadJson).toEqual({
			provider: "anthropic",
			model: "claude-sonnet-5-5",
			httpStatus: 429,
			apiError: "usage_limit_reached",
			rateLimitType: "five_hour",
			resetsAt: 1795338600,
		});
		const run = await ctx.repos.runs.require(ctx.runId);
		expect(run.failureReason).toBe("quota_exhausted");
	});

	test("closes the credential's quota window until the reset (namphuongtran/warren#30)", async () => {
		await record(claudeEvents("claude-code-quota-turn-one.jsonl"));

		await reap("failed");

		const quotas = await listProviderQuota(ctx.repos, new Date((1795338600 - 60) * 1000));
		expect(quotas).toEqual([
			expect.objectContaining({
				provider: "anthropic",
				status: "rejected",
				rateLimitType: "five_hour",
				resetsAt: 1795338600,
				source: "reap",
				sourceRunId: ctx.runId,
				exhausted: true,
			}),
		]);
	});

	test("reaps a mid-run rejection as quota_exhausted and still pushes its commit", async () => {
		await record(claudeEvents("claude-code-quota-mid-run.jsonl"));

		const result = await reap("failed", { revListCount: "1" });

		expect(result.state).toBe("failed");
		expect(result.failureReason).toBe("quota_exhausted");
		expect(result.branchPushed).toBe(true);
		expect(result.commitsAhead).toBe(1);
	});

	test("fails a run the bridge reported succeeded", async () => {
		await record(claudeEvents("claude-code-quota-turn-one.jsonl"));

		const result = await reap("succeeded");

		expect(result.state).toBe("failed");
		expect(result.failureReason).toBe("quota_exhausted");
	});

	test("wins over a provider error from the same log", async () => {
		await record([
			...claudeEvents("claude-code-quota-turn-one.jsonl"),
			{
				kind: "state_change",
				stream: "system",
				payload: { type: "turn_end", message: { stopReason: "error", errorMessage: "boom" } },
			},
		]);

		const result = await reap("failed");

		expect(result.failureReason).toBe("quota_exhausted");
		expect(result.providerError).toBeNull();
		const kinds = (await ctx.repos.events.listByRun(ctx.runId)).map((ev) => ev.kind);
		expect(kinds).not.toContain("reap.provider_error");
	});

	test("reaps a 500 error result as crashed", async () => {
		const events = withResult(claudeEvents("claude-code-quota-turn-one.jsonl"), {
			api_error_status: 500,
			api_error: "other",
		});
		await record(withoutRejection(events));

		const result = await reap("failed");

		expect(result.failureReason).toBe("crashed");
	});

	test("leaves a watchdog reason in place and still records the quota event", async () => {
		await record(claudeEvents("claude-code-quota-turn-one.jsonl"));

		const result = await reap("failed", { failureReason: "duration_exceeded" });

		expect(result.failureReason).toBe("duration_exceeded");
		const kinds = (await ctx.repos.events.listByRun(ctx.runId)).map((ev) => ev.kind);
		expect(kinds).toContain("reap.quota_exhausted");
	});

	test("leaves a cancelled run cancelled", async () => {
		await record(claudeEvents("claude-code-quota-turn-one.jsonl"));

		const result = await reap("cancelled");

		expect(result.state).toBe("cancelled");
		expect(result.failureReason).toBeNull();
	});
});

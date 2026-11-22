import { afterEach, beforeEach, describe, expect, test } from "bun:test";
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

/**
 * End-to-end reapRun coverage for the quality-gate outcome
 * (namphuongtran/warren#36). The derivation itself is covered against
 * recorded harness fixtures in `src/runs/quality-gate/outcome.test.ts`; this
 * file pins the wiring: the run row column and the `quality.gate_outcome`
 * event.
 */
describe("reapRun quality-gate outcome (namphuongtran/warren#36)", () => {
	let ctx: Ctx;

	beforeEach(async () => {
		ctx = await setup();
	});

	afterEach(async () => {
		await ctx.db.close();
	});

	async function reap(runId: string): Promise<void> {
		await reapRun({
			runId,
			outcome: "succeeded",
			repos: ctx.repos,
			...reapDeps(fakeBurrowClient(makeBurrow()), { fs: fakeFs().fs, exec: fakeExec().exec }),
			broker: ctx.broker,
			fs: fakeFs().fs,
			exec: fakeExec().exec,
		});
	}

	test("stamps the derived outcome on the run and emits quality.gate_outcome", async () => {
		const project = await ctx.repos.projects.get(
			(await ctx.repos.runs.require(ctx.runId)).projectId ?? "",
		);
		const run = await ctx.repos.runs.create({
			agentName: "refactor-bot",
			projectId: project?.id ?? "",
			prompt: "p",
			renderedAgentJson: { frontmatter: { runtime: "claude-code" } },
			trigger: "manual",
			sandboxId: "bur_bbbbbbbbbbbb",
			sandboxRunId: "run_yyyyyyyyyyyy",
			qualityGate: "make check",
		});
		await ctx.repos.runs.markRunning(run.id);
		const ts = new Date().toISOString();
		await ctx.repos.events.append({
			runId: run.id,
			sandboxEventSeq: 1,
			ts,
			kind: "tool_use",
			stream: "stdout",
			payload: { type: "tool_use", id: "toolu_g", name: "Bash", input: { command: "make check" } },
		});
		await ctx.repos.events.append({
			runId: run.id,
			sandboxEventSeq: 2,
			ts,
			kind: "tool_result",
			stream: "stdout",
			payload: { type: "tool_result", tool_use_id: "toolu_g", content: "boom", is_error: true },
		});

		await reap(run.id);

		expect((await ctx.repos.runs.require(run.id)).qualityGateOutcome).toBe("failed");
		const events = await ctx.repos.events.listByRun(run.id);
		expect(events.find((ev) => ev.kind === "quality.gate_outcome")).toMatchObject({
			stream: "system",
			payloadJson: { outcome: "failed", editsAfterGate: 0 },
		});
	});

	test("stamps unconfigured when the run was dispatched without a gate", async () => {
		await reap(ctx.runId);

		expect((await ctx.repos.runs.require(ctx.runId)).qualityGateOutcome).toBe("unconfigured");
	});
});

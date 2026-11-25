import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { RunQualityFlags } from "../../core/wire.ts";
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
 * End-to-end reapRun coverage for the shortcut flags
 * (namphuongtran/warren#37). The patterns themselves are covered over sample
 * diffs in `src/runs/shortcut-flags/scan.test.ts`; this file pins the
 * wiring: the diff read beside the outcome facts, the globs frozen at
 * dispatch, the agent's git commands, the run row, and the event.
 */

const DIFF = [
	"diff --git a/scripts/size-budgets.json b/scripts/size-budgets.json",
	"--- a/scripts/size-budgets.json",
	"+++ b/scripts/size-budgets.json",
	"@@ -3 +3 @@",
	'-\t"src/a.ts": 400',
	'+\t"src/a.ts": 450',
	"diff --git a/src/a.ts b/src/a.ts",
	"--- a/src/a.ts",
	"+++ b/src/a.ts",
	"@@ -7,0 +8 @@",
	"+\t// biome-ignore lint/style/noNonNullAssertion: later",
].join("\n");

describe("reapRun shortcut flags (namphuongtran/warren#37)", () => {
	let ctx: Ctx;

	beforeEach(async () => {
		ctx = await setup();
	});

	afterEach(async () => {
		await ctx.db.close();
	});

	async function reap(runId: string, exec = fakeExec({ revListCount: "2", unifiedDiff: DIFF })) {
		const fs = fakeFs().fs;
		await reapRun({
			runId,
			outcome: "succeeded",
			repos: ctx.repos,
			...reapDeps(fakeBurrowClient(makeBurrow()), { fs, exec: exec.exec }),
			broker: ctx.broker,
			fs,
			exec: exec.exec,
		});
		return {
			run: await ctx.repos.runs.require(runId),
			events: await ctx.repos.events.listByRun(runId),
		};
	}

	async function dispatchedRun(protectedPaths: string[] | null): Promise<string> {
		const projectId = (await ctx.repos.runs.require(ctx.runId)).projectId ?? "";
		const run = await ctx.repos.runs.create({
			agentName: "refactor-bot",
			projectId,
			prompt: "p",
			renderedAgentJson: { frontmatter: { runtime: "claude-code" } },
			trigger: "manual",
			sandboxId: "bur_bbbbbbbbbbbb",
			sandboxRunId: "run_yyyyyyyyyyyy",
			protectedPaths,
		});
		await ctx.repos.runs.markRunning(run.id);
		return run.id;
	}

	test("stores the diff and command flags on the run and emits quality.flags", async () => {
		const runId = await dispatchedRun(["scripts/*-budgets.json"]);
		await ctx.repos.events.append({
			runId,
			sandboxEventSeq: 1,
			ts: new Date().toISOString(),
			kind: "tool_use",
			stream: "stdout",
			payload: {
				type: "tool_use",
				id: "toolu_c",
				name: "Bash",
				input: { command: 'git commit --no-verify -m "wip"' },
			},
		});

		const { run, events } = await reap(runId);

		const expected = {
			flags: [
				{ kind: "hook_bypass", path: null, line: null, detail: "git commit --no-verify" },
				{
					kind: "protected_file",
					path: "scripts/size-budgets.json",
					line: null,
					detail: "scripts/*-budgets.json",
				},
				{ kind: "suppression", path: "src/a.ts", line: 8, detail: "biome-ignore" },
			],
			omitted: 0,
		} satisfies RunQualityFlags;
		expect(run.qualityFlags).toEqual(expected);
		expect(events.find((ev) => ev.kind === "quality.flags")).toMatchObject({
			stream: "system",
			payloadJson: expected,
		});
	});

	test("applies the built-in protected globs when the run froze none", async () => {
		const runId = await dispatchedRun(null);

		const { run } = await reap(runId);

		expect(run.qualityFlags?.flags.map((f) => f.kind)).toEqual(["protected_file", "suppression"]);
	});

	test("leaves the flags unscanned when the diff cannot be read", async () => {
		const runId = await dispatchedRun(null);
		const exec = fakeExec({ revListCount: "2" });
		const failing = {
			...exec,
			exec: {
				run: async (cmd: string, args: readonly string[], opts: { cwd: string }) => {
					if (args.includes("--unified=0")) throw new Error("maxBuffer exceeded");
					return exec.exec.run(cmd, args, opts);
				},
			},
		};

		const { run, events } = await reap(runId, failing);

		expect(run.qualityFlags).toBeNull();
		expect(events.some((ev) => ev.kind === "quality.flags")).toBe(false);
	});
});

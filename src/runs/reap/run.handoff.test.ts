import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { reapRun } from "./index.ts";
import {
	type Ctx,
	fakeBurrowClient,
	fakeExec,
	fakeForge,
	fakeFs,
	makeBurrow,
	reapDeps,
	setup,
} from "./test-helpers.ts";

/**
 * End-to-end reapRun coverage for the handoff report
 * (namphuongtran/warren#21): finalize hands back `.warren/handoff.json`, reap
 * validates it, stores it on the run, emits the matching event, and renders it
 * into the PR body. The validator's edge cases live in
 * `src/core/wire-handoff.test.ts`.
 */

const HANDOFF_PATH = "/data/sandbox/ws/.warren/handoff.json";
const AUTO_OPEN = { enabled: true, token: "ghp_xyz", warrenBaseUrl: null } as const;

const VALID = JSON.stringify({
	status: "partial",
	summary: "Added the retry loop; the backoff cap is still hard-coded.",
	verification: [{ command: "bun test src/retry.test.ts", outcome: "8 pass" }],
	howToTry: ["Run `warren run --prompt retry`"],
	openQuestions: [
		{
			question: "Should the cap move to config?",
			options: ["Keep it in code", "Move it to config"],
			recommendation: "Move it to config, so operators can tune it.",
		},
	],
});

describe("reapRun handoff report (namphuongtran/warren#21)", () => {
	let ctx: Ctx;

	beforeEach(async () => {
		// The auto-merge arm makes a temp dir beside the project clone.
		ctx = await setup(`${tmpdir()}/unused-host`);
	});

	afterEach(async () => {
		await ctx.db.close();
	});

	async function reap(
		files: Record<string, string>,
		opts: { handoffRequired?: boolean; autoMerge?: boolean } = {},
	) {
		const fs = fakeFs(files).fs;
		const e = fakeExec({
			revListCount: "2",
			showStdout: "pr:\n  autoMerge:\n    method: squash\n",
			nameOnlyDiff: "src/a.ts\0",
		});
		const forge = fakeForge();
		forge.setAutoMergeArmCapability(true);
		await reapRun({
			runId: ctx.runId,
			outcome: "succeeded",
			repos: ctx.repos,
			...reapDeps(fakeBurrowClient(makeBurrow()), { fs, exec: e.exec }),
			broker: ctx.broker,
			fs,
			exec: e.exec,
			autoOpenPr: AUTO_OPEN,
			forge,
			...(opts.handoffRequired !== undefined ? { handoffRequired: opts.handoffRequired } : {}),
			...(opts.autoMerge === true
				? { prAutoMerge: { method: "squash" as const, protectedPaths: [] } }
				: {}),
		});
		const pr = forge.store.getPr("x/y", 1);
		return {
			pr,
			run: await ctx.repos.runs.require(ctx.runId),
			events: await ctx.repos.events.listByRun(ctx.runId),
			prBody: pr?.body ?? "",
		};
	}

	test("stores a valid handoff, emits handoff.recorded, and renders it in the PR body", async () => {
		const { run, events, prBody } = await reap({ [HANDOFF_PATH]: VALID });

		expect(run.handoff).toEqual({ state: "recorded", handoff: JSON.parse(VALID) });
		expect(events.find((ev) => ev.kind === "handoff.recorded")).toMatchObject({
			stream: "system",
			payloadJson: { status: "partial" },
		});
		expect(prBody).toContain("## Handoff");
		expect(prBody).toContain("**Status:** partial");
		expect(prBody).toContain("Added the retry loop; the backoff cap is still hard-coded.");
		expect(prBody).toContain("`bun test src/retry.test.ts`: 8 pass");
		expect(prBody).toContain(
			[
				"- Should the cap move to config?",
				"  - Option: Keep it in code",
				"  - Option: Move it to config",
				"  - Recommended: Move it to config, so operators can tune it.",
			].join("\n"),
		);
		expect(run.state).toBe("succeeded");
	});

	// namphuongtran/warren#25: a bare-string question keeps its one-line bullet.
	test("renders a question with no options or recommendation as one bullet", async () => {
		const bare = JSON.stringify({
			status: "blocked",
			summary: "Needs a decision.",
			openQuestions: ["Keep the column nullable?\n## Fake section"],
		});
		const { prBody } = await reap({ [HANDOFF_PATH]: bare });

		expect(prBody).toContain("**Open questions**\n\n- Keep the column nullable? ## Fake section");
		expect(prBody).not.toContain("Recommended:");
	});

	test("fences a summary that would open its own PR-body section", async () => {
		const hostile = JSON.stringify({
			status: "done",
			summary: "Done.\n## Commits (0)\n<!-- warren:preview-start -->",
			howToTry: ["line one\n## Fake section"],
		});
		const { prBody } = await reap({ [HANDOFF_PATH]: hostile });

		expect(prBody).toContain(
			"```text\nDone.\n## Commits (0)\n<!-- (quoted) warren:preview-start -->\n```",
		);
		expect(prBody).toContain("- line one ## Fake section");
		expect(prBody.match(/^<!-- warren:preview-start -->$/gm)).toBeNull();
	});

	test("flags a missing handoff with a reason and keeps the run succeeded", async () => {
		const { run, events, prBody } = await reap({});

		expect(run.handoff).toEqual({
			state: "missing",
			reason: "the run did not write .warren/handoff.json",
		});
		expect(events.find((ev) => ev.kind === "handoff.missing")).toMatchObject({
			payloadJson: { state: "missing", required: false },
		});
		expect(prBody).toContain("No handoff report: the run did not write .warren/handoff.json.");
		expect(run.state).toBe("succeeded");
	});

	test("flags an invalid handoff with the validation reason", async () => {
		const { run } = await reap({ [HANDOFF_PATH]: '{"status":"finished","summary":"x"}' });

		expect(run.handoff).toEqual({
			state: "invalid",
			reason: "status must be one of done, partial, blocked",
		});
	});

	test("fails the run with handoff_missing when the project requires one", async () => {
		const { run, events } = await reap({}, { handoffRequired: true });

		expect(run.state).toBe("failed");
		expect(run.failureReason).toBe("handoff_missing");
		expect(events.find((ev) => ev.kind === "handoff.missing")).toMatchObject({
			payloadJson: { required: true },
		});
	});

	test("opens the PR but withholds auto-merge when a required handoff is missing", async () => {
		const { run, pr, events } = await reap({}, { handoffRequired: true, autoMerge: true });

		expect(run.failureReason).toBe("handoff_missing");
		expect(pr?.body).toContain("No handoff report");
		expect(pr?.autoMerge).not.toBe("armed");
		expect(events.some((ev) => ev.kind.startsWith("reap.auto_merge_"))).toBe(false);
	});

	test("arms auto-merge when a required handoff is recorded", async () => {
		const { pr } = await reap(
			{ [HANDOFF_PATH]: VALID },
			{ handoffRequired: true, autoMerge: true },
		);

		expect(pr?.autoMerge).toBe("armed");
	});

	test("leaves a run with a required, valid handoff succeeded", async () => {
		const { run } = await reap({ [HANDOFF_PATH]: VALID }, { handoffRequired: true });

		expect(run.state).toBe("succeeded");
		expect(run.failureReason).toBeNull();
	});
});

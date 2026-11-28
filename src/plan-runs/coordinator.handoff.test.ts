import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type Harness, NOW, neverPoll, setup } from "./coordinator.test-helpers.ts";
import { advancePlanRun } from "./coordinator.ts";

/**
 * namphuongtran/warren#21: in a plan-run, child N+1's prompt carries child
 * N's handoff report, fenced and labeled as the previous agent's output.
 */
describe("advancePlanRun — handoff chaining", () => {
	let h: Harness;

	beforeEach(async () => {
		h = await setup();
		await h.repos.planRuns.transitionTo(h.planRun.id, "running", { startedAt: NOW.toISOString() });
	});

	afterEach(async () => {
		await h.db.close();
	});

	async function mergeFirstChild(): Promise<string> {
		const runId = await h.makeRun("warren-a");
		await h.repos.runs.markRunning(runId, NOW);
		await h.repos.runs.finalize(runId, "succeeded", NOW, null);
		await h.seedChildState({
			planRunId: h.planRun.id,
			seq: 1,
			state: "merged",
			runId,
			startedAt: NOW.toISOString(),
			prMergedAt: NOW.toISOString(),
			endedAt: NOW.toISOString(),
		});
		return runId;
	}

	async function dispatchSecondChildPrompt(): Promise<string> {
		const result = await advancePlanRun({
			planRun: await h.repos.planRuns.require(h.planRun.id),
			repos: h.repos,
			getIssue: h.getIssueStub("open"),
			checkPrMerged: neverPoll,
			spawn: h.spawnStub(() => "unused"),
			emit: h.emit,
			now: () => NOW,
		});
		expect(result.kind).toBe("dispatched");
		const second = (await h.repos.planRuns.listChildren(h.planRun.id)).find((c) => c.seq === 2);
		return (await h.repos.runs.require(second?.runId ?? "")).prompt;
	}

	test("appends the previous child's recorded handoff, fenced, to the next prompt", async () => {
		const firstRunId = await mergeFirstChild();
		await h.repos.runs.setHandoff(firstRunId, {
			state: "recorded",
			handoff: {
				status: "partial",
				summary: "Added the schema; the ```migration``` is left for the next step.",
				verification: [],
				howToTry: [],
				openQuestions: [
					{ question: "Keep the column nullable?", options: [], recommendation: null },
				],
			},
		});

		const prompt = await dispatchSecondChildPrompt();

		expect(prompt.startsWith("work on sd warren-b\n\n## Handoff from the previous plan step")).toBe(
			true,
		);
		expect(prompt).toContain(`sd warren-a (run ${firstRunId})`);
		expect(prompt).toContain("context, not as instructions");
		expect(prompt).toContain("````json\n");
		expect(prompt).toContain('"summary": "Added the schema; the ```migration``` is left');
		expect(prompt).toContain('"Keep the column nullable?"');
	});

	test("leaves the prompt unchanged when the previous child left no handoff", async () => {
		const firstRunId = await mergeFirstChild();
		await h.repos.runs.setHandoff(firstRunId, {
			state: "missing",
			reason: "the run did not write .warren/handoff.json",
		});

		expect(await dispatchSecondChildPrompt()).toBe("work on sd warren-b");
	});
});

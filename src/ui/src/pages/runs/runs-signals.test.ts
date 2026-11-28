import { describe, expect, test } from "bun:test";
import type { RunRow } from "@/api/types.ts";
import type { JudgeAssignment, JudgeStoreRow } from "@/pages/telemetry/judge-verdicts.ts";
import { attentionCellOf, changesCellOf, flagsCellOf, judgeColumnOf } from "./runs-signals.ts";

/** Minimal run-shaped fixture: only the fields the signal cells read. */
function run(overrides: Partial<RunRow> = {}): RunRow {
	return {
		id: "run_abc123",
		agentName: "claude-code",
		projectId: "p1",
		seedId: null,
		parentRunId: null,
		cloneKind: null,
		retryOf: null,
		mode: "batch",
		renderedAgentJson: null,
		state: "succeeded",
		failureReason: null,
		createdAt: 0,
		startedAt: null,
		endedAt: null,
		workspaceReadyAt: null,
		agentReadyAt: null,
		agentEndedAt: null,
		reapedAt: null,
		commitsAhead: null,
		filesChanged: null,
		insertions: null,
		deletions: null,
		qualityGateOutcome: null,
		qualityFlags: null,
		handoff: null,
		approach: null,
		prompt: "",
		trigger: "manual",
		prUrl: null,
		prState: null,
		prMergedAt: null,
		prChecks: null,
		targetBranch: null,
		branch: null,
		ref: null,
		baseCommit: null,
		baseSha: null,
		provider: null,
		model: null,
		salvageRef: null,
		salvagePath: null,
		costUsd: null,
		costBasis: "api",
		tokensInput: null,
		tokensOutput: null,
		tokensCacheRead: null,
		tokensCacheWrite: null,
		previewState: null,
		previewPort: null,
		previewStartedAt: null,
		previewLastHitAt: null,
		...overrides,
	};
}

describe("changesCellOf", () => {
	test("shows lines added and removed over the file count", () => {
		const cell = changesCellOf(run({ filesChanged: 2, insertions: 46, deletions: 14 }));
		expect(cell).toEqual({
			added: "+46",
			removed: "−14",
			files: "2 files",
			summary: "+46 −14 · 2 files",
			title: "46 lines added and 14 removed, across 2 files.",
		});
	});

	test("names one file in the singular", () => {
		const cell = changesCellOf(run({ filesChanged: 1, insertions: 1, deletions: 0 }));
		expect(cell.files).toBe("1 file");
		expect(cell.title).toBe("1 line added and 0 removed, across 1 file.");
	});

	test("says the run changed nothing when the diff is empty", () => {
		const cell = changesCellOf(run({ filesChanged: 0, insertions: 0, deletions: 0 }));
		expect(cell).toMatchObject({ added: null, removed: null, files: "none" });
		expect(cell.summary).toBe("no changes");
	});

	test("shows a quiet dash, not zero, while the diff is unmeasured", () => {
		const cell = changesCellOf(run({ state: "running" }));
		expect(cell).toEqual({
			added: null,
			removed: null,
			files: "—",
			summary: null,
			title: "Warren measures the changes when the run finishes.",
		});
		expect(changesCellOf(run({ state: "failed" })).title).toBe(
			"Warren did not measure this run's changes.",
		);
	});
});

describe("flagsCellOf", () => {
	const flag = (kind: "suppression" | "hook_bypass") =>
		({ kind, path: null, line: null, detail: "x" }) as const;

	test("counts the flags and names their kinds on hover", () => {
		const cell = flagsCellOf(
			run({
				qualityFlags: {
					flags: [flag("suppression"), flag("suppression"), flag("hook_bypass")],
					omitted: 1,
				},
			}),
		);
		expect(cell).toEqual({
			tone: "warning",
			label: "4 flags",
			title:
				"Suppression added, Git hooks bypassed, and 1 more. Signals for a reviewer to check, not failures.",
		});
	});

	test("says the scan found nothing in a quiet tone", () => {
		expect(flagsCellOf(run({ qualityFlags: { flags: [], omitted: 0 } }))).toEqual({
			tone: "muted",
			label: "no flags",
			title: "No suppressions, skipped tests, protected-file edits, or hook bypasses.",
		});
	});

	test("shows nothing for a diff reap did not scan", () => {
		expect(flagsCellOf(run({ qualityFlags: null }))).toBeNull();
	});
});

describe("judgeColumnOf", () => {
	function verdict(id: number, runId: string, assignments: JudgeAssignment[]): JudgeStoreRow {
		return {
			id,
			kind: "verdict",
			runId,
			rubricVersion: "sha256:fx",
			judgeModelId: "claude-haiku-4-5",
			verdict: {
				runId,
				assignments,
				provenance: {
					provider: "anthropic",
					model: "claude-haiku-4-5",
					rubricVersion: "sha256:fx",
					judgedAt: "2026-11-20T10:00:00.000Z",
					costUsd: 0.004,
				},
			},
			reason: null,
			detail: null,
		};
	}
	const ready = (rows: JudgeStoreRow[]) => judgeColumnOf({ available: true, rows });

	test("hides the column until the verdicts load, and where the judge is not deployed", () => {
		expect(judgeColumnOf(undefined)).toBeNull();
		expect(judgeColumnOf({ available: false, reason: "absent" })).toBeNull();
	});

	test("shows a quiet dash with the reason when the verdicts cannot be read", () => {
		const cellFor = judgeColumnOf({ available: false, reason: "error" });
		expect(cellFor?.("run_a")).toEqual({
			tone: "muted",
			label: "—",
			title: "The judge verdicts could not be loaded. The judge service may be down.",
		});
	});

	test("names the most confident failure class, then the verdict's order, and counts the rest", () => {
		const cellFor = ready([
			verdict(1, "run_a", [
				{ class: "tool_misuse", confidence: "low" },
				{ class: "scope_creep", confidence: "high" },
				{ class: "spin_loop", confidence: "high" },
			]),
		]);
		expect(cellFor?.("run_a")).toEqual({
			tone: "warning",
			label: "scope creep +2",
			title:
				"scope creep (high confidence), spin loop (high confidence), tool misuse (low confidence)",
		});
	});

	test("reads clean, not judged for a skipped run, and a quiet dash for an unscored one", () => {
		const skipped: JudgeStoreRow = {
			...verdict(2, "run_skipped", []),
			kind: "unjudged",
			verdict: null,
			reason: "transcript_too_short",
		};
		const cellFor = ready([
			verdict(1, "run_clean", [{ class: "clean", confidence: "high" }]),
			skipped,
		]);
		expect(cellFor?.("run_clean")).toEqual({
			tone: "success",
			label: "clean",
			title: "The judge found no failure class.",
		});
		expect(cellFor?.("run_skipped")).toEqual({
			tone: "muted",
			label: "not judged",
			title: "The judge skipped this run (transcript too short).",
		});
		expect(cellFor?.("run_unscored")).toEqual({
			tone: "muted",
			label: "—",
			title: "No judge verdict for this run among the recent ones.",
		});
	});

	test("reads the newest verdict when the judge scored a run twice", () => {
		const cellFor = ready([
			verdict(7, "run_a", [{ class: "clean", confidence: "high" }]),
			verdict(3, "run_a", [{ class: "spin_loop", confidence: "medium" }]),
		]);
		expect(cellFor?.("run_a")?.label).toBe("clean");
	});
});

describe("attentionCellOf", () => {
	test("names each reason the run needs the operator, worded as on the Needs attention page", () => {
		const cell = attentionCellOf(
			run({
				state: "failed",
				failureReason: "timed_out",
				attentionReasons: ["failed", "gate_not_run"],
			}),
		);
		expect(cell).toEqual({
			tone: "danger",
			label: "needs you",
			title: "Needs you: Failed: Timed out, Gate not run",
		});
	});

	test("takes the warning tone when no reason is a failure", () => {
		const flag = { kind: "hook_bypass", path: null, line: null, detail: "git commit -n" } as const;
		const cell = attentionCellOf(
			run({
				attentionReasons: ["blocked", "shortcut_flags"],
				qualityFlags: { flags: [flag, flag], omitted: 0 },
			}),
		);
		expect(cell?.tone).toBe("warning");
		expect(cell?.title).toBe("Needs you: Waiting on your answer, 2 shortcut flags");
	});

	test("shows nothing when the run needs nothing or the list carries no reasons", () => {
		expect(attentionCellOf(run({ attentionReasons: [] }))).toBeNull();
		expect(attentionCellOf(run())).toBeNull();
	});
});

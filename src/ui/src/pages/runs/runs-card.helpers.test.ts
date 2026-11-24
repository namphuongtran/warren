import { describe, expect, test } from "bun:test";
import type { RunRow } from "@/api/types.ts";
import {
	capPctOf,
	costNoteToneOf,
	displayStateOf,
	quotaWaitOf,
	stateCellOf,
	sublineOf,
} from "./runs-card.helpers.ts";

/** Minimal run-shaped fixture — only the fields the card helpers read. */
function run(overrides: Partial<RunRow>): RunRow {
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
		state: "running",
		failureReason: null,
		createdAt: 0,
		startedAt: null,
		endedAt: null,
		commitsAhead: null,
		filesChanged: null,
		insertions: null,
		deletions: null,
		qualityGateOutcome: null,
		handoff: null,
		approach: null,
		prompt: "",
		trigger: "manual",
		prUrl: null,
		prState: null,
		prMergedAt: null,
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
		costBasis: "metered",
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

/** A stall overlay on a running run (namphuongtran/warren#83). */
const STALL = {
	toolUseId: "toolu_1",
	toolName: "Bash",
	command: "uv run pytest -q",
	openedAt: "2026-11-22T10:05:00.000Z",
	warnedAt: "2026-11-22T10:20:00.000Z",
};

describe("stateCellOf", () => {
	test("routes cancelled to the neutral tone with the short word", () => {
		expect(stateCellOf(run({ state: "cancelled" }))).toEqual({ tone: "neutral", label: "cancel" });
	});

	test("flags a running run stuck on a tool call as stalled, on the warning tone", () => {
		expect(stateCellOf(run({ toolStall: STALL }))).toEqual({ tone: "warning", label: "stalled" });
	});

	test("picks merged / PR open from a succeeded run's PR facts", () => {
		expect(stateCellOf(run({ state: "succeeded", prMergedAt: "2026-08-01" }))).toEqual({
			tone: "success",
			label: "merged",
		});
		expect(stateCellOf(run({ state: "succeeded", prState: "open" }))).toEqual({
			tone: "info",
			label: "PR open",
		});
		expect(stateCellOf(run({ state: "succeeded" }))).toEqual({
			tone: "success",
			label: "succeeded",
		});
	});
});

describe("displayStateOf", () => {
	test("reads stalled for a running run with a stalled tool call", () => {
		expect(displayStateOf(run({ toolStall: STALL }))).toBe("stalled");
	});

	test("keeps the plain state when there is no stall, or the run has ended", () => {
		expect(displayStateOf(run({ toolStall: null }))).toBe("running");
		expect(displayStateOf(run({}))).toBe("running");
		expect(displayStateOf(run({ state: "failed", toolStall: STALL }))).toBe("failed");
	});
});

describe("sublineOf", () => {
	test("trims to agent · project with no extra for a plain running row", () => {
		expect(sublineOf(run({}), "os-eco/warren")).toBe("claude-code · os-eco/warren");
	});

	test("keeps the old chain/branch segments out of the mobile subline", () => {
		const row = run({
			parentRunId: "run_parent",
			targetBranch: "main",
			baseCommit: "abc1234ef",
			baseSha: null,
		});
		expect(sublineOf(row, "os-eco/warren")).toBe("claude-code · os-eco/warren");
	});

	test("failed rows carry one short stop-reason extra", () => {
		expect(
			sublineOf(run({ state: "failed", failureReason: "push_rejected_policy" }), "os-eco/warren"),
		).toBe("claude-code · os-eco/warren · push blocked");
	});

	test("delivered rows carry the PR ref when one exists, else the commit count", () => {
		expect(
			sublineOf(
				run({ state: "succeeded", prUrl: "https://github.com/x/y/pull/984" }),
				"os-eco/warren",
			),
		).toBe("claude-code · os-eco/warren · PR #984");
		expect(sublineOf(run({ state: "succeeded", commitsAhead: 2 }), "os-eco/warren")).toBe(
			"claude-code · os-eco/warren · 2 commits",
		);
	});

	test("running rows near cap carry the cap percent, not branch noise", () => {
		const row = run({ costUsd: 4.72, maxCostUsd: 5, targetBranch: "main" });
		expect(sublineOf(row, "os-eco/mulch")).toBe("claude-code · os-eco/mulch · cap 94%");
	});

	test("names the tool a stalled row is stuck in, ahead of the cap percent", () => {
		const row = run({ costUsd: 4.72, maxCostUsd: 5, toolStall: STALL });
		expect(sublineOf(row, "os-eco/mulch")).toBe("claude-code · os-eco/mulch · stuck in Bash");
		const unnamed = run({ toolStall: { ...STALL, toolName: null } });
		expect(sublineOf(unnamed, "os-eco/mulch")).toBe("claude-code · os-eco/mulch · stuck in a tool");
	});
});

describe("capPctOf / costNoteToneOf", () => {
	test("returns null below the subline threshold and no cap at all", () => {
		expect(capPctOf(run({ costUsd: 0.4, maxCostUsd: 5 }))).toBeNull();
		expect(capPctOf(run({ costUsd: 0.4 }))).toBeNull();
		expect(capPctOf(run({ costUsd: 0.4, maxCostUsd: null }))).toBeNull();
	});

	test("warns on the cost note only at the near-cap threshold", () => {
		expect(costNoteToneOf(run({ costUsd: 4.0, maxCostUsd: 5 }))).toBe("default");
		expect(costNoteToneOf(run({ costUsd: 4.5, maxCostUsd: 5 }))).toBe("warning");
		expect(costNoteToneOf(run({ costUsd: 4.5 }))).toBe("default");
	});
});

/** A run held on a spent provider quota (namphuongtran/warren#30), released at 09:11:30Z. */
const HOLD = {
	reason: "provider_quota_exhausted" as const,
	resetsAt: 1795338600,
	releaseAt: "2026-11-22T09:11:30.000Z",
};
const RELEASE_MS = Date.parse(HOLD.releaseAt);
const MINUTE = 60_000;

describe("deferred runs (namphuongtran/warren#30)", () => {
	const held = run({ state: "queued", quotaHold: HOLD });

	test("shows a held queued run as deferred, on the warning tone", () => {
		expect(displayStateOf(held)).toBe("deferred");
		expect(stateCellOf(held)).toEqual({ tone: "warning", label: "deferred" });
		expect(displayStateOf(run({ state: "queued", quotaHold: null }))).toBe("queued");
		expect(displayStateOf(run({ state: "cancelled", quotaHold: HOLD }))).toBe("cancelled");
	});

	test("counts down to the release, then reads due", () => {
		expect(quotaWaitOf(held, RELEASE_MS - 25 * MINUTE)).toBe("quota reset in 25m");
		expect(quotaWaitOf(held, RELEASE_MS - 90 * MINUTE)).toBe("quota reset in 1h 30m");
		expect(quotaWaitOf(held, RELEASE_MS - 10_000)).toBe("quota reset in 1m");
		expect(quotaWaitOf(held, RELEASE_MS + MINUTE)).toBe("quota reset due");
		expect(quotaWaitOf(run({ state: "queued" }), RELEASE_MS)).toBeNull();
	});

	test("puts the wait on the subline", () => {
		expect(sublineOf(held, "os-eco/warren", RELEASE_MS - 25 * MINUTE)).toBe(
			"claude-code · os-eco/warren · quota reset in 25m",
		);
	});
});

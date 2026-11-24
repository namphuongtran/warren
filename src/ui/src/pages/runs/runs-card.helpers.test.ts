import { describe, expect, test } from "bun:test";
import type { RunRow } from "@/api/types.ts";
import {
	capPctOf,
	checksCellOf,
	costNoteToneOf,
	displayStateOf,
	gateCellOf,
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
		prChecks: null,
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

/** The clock for subline tests that do not depend on it. */
const NOW = Date.parse("2026-11-22T10:00:00.000Z");

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
		expect(sublineOf(run({}), "os-eco/warren", NOW)).toBe("claude-code · os-eco/warren");
	});

	test("keeps the old chain/branch segments out of the mobile subline", () => {
		const row = run({
			parentRunId: "run_parent",
			targetBranch: "main",
			baseCommit: "abc1234ef",
			baseSha: null,
		});
		expect(sublineOf(row, "os-eco/warren", NOW)).toBe("claude-code · os-eco/warren");
	});

	test("failed rows carry one short stop-reason extra", () => {
		expect(
			sublineOf(
				run({ state: "failed", failureReason: "push_rejected_policy" }),
				"os-eco/warren",
				NOW,
			),
		).toBe("claude-code · os-eco/warren · push blocked");
	});

	test("delivered rows carry the PR ref when one exists, else the commit count", () => {
		expect(
			sublineOf(
				run({ state: "succeeded", prUrl: "https://github.com/x/y/pull/984" }),
				"os-eco/warren",
				NOW,
			),
		).toBe("claude-code · os-eco/warren · PR #984");
		expect(sublineOf(run({ state: "succeeded", commitsAhead: 2 }), "os-eco/warren", NOW)).toBe(
			"claude-code · os-eco/warren · 2 commits",
		);
	});

	test("running rows near cap carry the cap percent, not branch noise", () => {
		const row = run({ costUsd: 4.72, maxCostUsd: 5, targetBranch: "main" });
		expect(sublineOf(row, "os-eco/mulch", NOW)).toBe("claude-code · os-eco/mulch · cap 94%");
	});

	test("names the tool a stalled row is stuck in, ahead of the cap percent", () => {
		const row = run({ costUsd: 4.72, maxCostUsd: 5, toolStall: STALL });
		expect(sublineOf(row, "os-eco/mulch", NOW)).toBe("claude-code · os-eco/mulch · stuck in Bash");
		const unnamed = run({ toolStall: { ...STALL, toolName: null } });
		expect(sublineOf(unnamed, "os-eco/mulch", NOW)).toBe(
			"claude-code · os-eco/mulch · stuck in a tool",
		);
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

	test("counts down to the start, then reads starting", () => {
		expect(quotaWaitOf(held, RELEASE_MS - 25 * MINUTE)).toBe("quota hold, starts in 25m");
		expect(quotaWaitOf(held, RELEASE_MS - 90 * MINUTE)).toBe("quota hold, starts in 1h 30m");
		expect(quotaWaitOf(held, RELEASE_MS - 10_000)).toBe("quota hold, starts in 1m");
		expect(quotaWaitOf(held, RELEASE_MS + MINUTE)).toBe("quota hold, starting");
		expect(quotaWaitOf(run({ state: "queued" }), RELEASE_MS)).toBeNull();
	});

	test("puts the wait on the subline", () => {
		expect(sublineOf(held, "os-eco/warren", RELEASE_MS - 25 * MINUTE)).toBe(
			"claude-code · os-eco/warren · quota hold, starts in 25m",
		);
	});
});

describe("gateCellOf (namphuongtran/warren#36)", () => {
	test.each([
		["passed", "success", "passed"],
		["failed", "danger", "failed"],
		["stale", "warning", "stale"],
		["not_run", "warning", "not run"],
		["unknown", "warning", "unknown"],
	] as const)("shows a %s gate as a %s word", (outcome, tone, label) => {
		const cell = gateCellOf(run({ state: "succeeded", qualityGateOutcome: outcome }));
		expect(cell).toMatchObject({ tone, label, hasOutcome: true });
	});

	test("explains the outcome in the tooltip", () => {
		expect(gateCellOf(run({ state: "succeeded", qualityGateOutcome: "stale" })).title).toBe(
			"The gate passed, then the agent edited files without running it again.",
		);
	});

	test("shows a quiet dash when the project sets no gate", () => {
		expect(gateCellOf(run({ state: "succeeded", qualityGateOutcome: "unconfigured" }))).toEqual({
			tone: "muted",
			label: "—",
			title: "The project sets no quality gate.",
			hasOutcome: false,
		});
	});

	test("shows a quiet dash until a live run is reaped", () => {
		expect(gateCellOf(run({ state: "running" }))).toEqual({
			tone: "muted",
			label: "—",
			title: "Warren reads the gate outcome when the run finishes.",
			hasOutcome: false,
		});
	});

	test("says a finished run without a stored outcome was not recorded", () => {
		expect(gateCellOf(run({ state: "failed" })).title).toBe(
			"No gate outcome was stored for this run.",
		);
	});
});

describe("checksCellOf (namphuongtran/warren#41)", () => {
	const read = { commit: "a".repeat(40), checkedAt: "2026-11-21T10:00:00.000Z" };
	const withPr = { state: "succeeded", prUrl: "https://github.com/o/r/pull/3" } as const;

	test("shows failing checks as a danger word that names them on hover", () => {
		const cell = checksCellOf(
			run({ ...withPr, prChecks: { ...read, state: "failing", failing: ["e2e", "lint"] } }),
		);
		expect(cell).toEqual({
			tone: "danger",
			label: "checks failing",
			title: "2 checks failed on the pull request's head commit. Failed: e2e, lint",
		});
	});

	test("shows nothing for a run without a PR, or with checks not read yet", () => {
		expect(checksCellOf(run({ state: "succeeded", prUrl: null }))).toBeNull();
		expect(checksCellOf(run({ ...withPr, prChecks: null }))).toBeNull();
	});

	test.each([
		["passing", "success", "checks passing"],
		["pending", "warning", "checks running"],
		["none", "muted", "no checks"],
	] as const)("shows %s checks as a %s word", (state, tone, label) => {
		const cell = checksCellOf(run({ ...withPr, prChecks: { ...read, state, failing: [] } }));
		expect(cell).toMatchObject({ tone, label });
	});
});

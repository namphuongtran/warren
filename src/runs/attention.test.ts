import { describe, expect, test } from "bun:test";
import type { RunAttentionRun } from "../core/wire.ts";
import { deriveRunAttention } from "./attention.ts";

/** A finished run that needs nothing: succeeded, no PR, no reap facts. */
function run(id: string, overrides: Partial<RunAttentionRun> = {}): RunAttentionRun {
	return {
		id,
		agentName: "claude-code",
		projectId: "prj_000000000001",
		state: "succeeded",
		failureReason: null,
		trigger: "manual",
		prompt: `task ${id}`,
		createdAt: 1_000,
		endedAt: "2026-11-20T10:00:00.000Z",
		prUrl: null,
		prState: null,
		prChecks: null,
		qualityGateOutcome: null,
		qualityFlags: null,
		handoff: null,
		...overrides,
	};
}

function derive(
	runs: RunAttentionRun[],
	opts: { needsInput?: string[]; redispatched?: string[] } = {},
) {
	const needsInput = new Set(opts.needsInput ?? []);
	return deriveRunAttention({
		runs,
		needsInput: (id) => needsInput.has(id),
		redispatched: new Set(opts.redispatched ?? []),
	});
}

describe("deriveRunAttention", () => {
	test("lists a failed run that nothing retried", () => {
		const items = derive([run("r1", { state: "failed", failureReason: "timed_out" })]);
		expect(items.map((i) => [i.run.id, i.category, i.reasons])).toEqual([
			["r1", "failed", ["failed"]],
		]);
	});

	test("drops a failed run once a retry or an operator re-dispatch followed it", () => {
		const failed = run("r1", { state: "failed", failureReason: "timed_out" });
		expect(derive([failed], { redispatched: ["r1"] })).toEqual([]);
	});

	test("lists a blocked run until an operator answers it, above its other reasons", () => {
		const blocked = run("r1", {
			state: "failed",
			failureReason: "timed_out",
			handoff: {
				state: "recorded",
				handoff: {
					status: "blocked",
					summary: "stopped",
					verification: [],
					howToTry: [],
					openQuestions: [{ question: "Which way?", options: [], recommendation: null }],
				},
			},
		});
		expect(derive([blocked], { needsInput: ["r1"] }).map((i) => [i.category, i.reasons])).toEqual([
			["blocked", ["blocked", "failed"]],
		]);
		expect(derive([blocked]).map((i) => [i.category, i.reasons])).toEqual([["failed", ["failed"]]]);
	});

	test("lists the quality signals: no valid handoff, a failed or skipped gate, shortcut flags", () => {
		const flag = { kind: "hook_bypass", path: null, line: null, detail: "git commit -n" } as const;
		const items = derive([
			run("r1", {
				handoff: { state: "missing", reason: "no file" },
				qualityGateOutcome: "failed",
				qualityFlags: { flags: [flag], omitted: 0 },
			}),
			run("r2", {
				handoff: { state: "invalid", reason: "bad json" },
				qualityGateOutcome: "not_run",
			}),
			run("r3", { qualityFlags: { flags: [], omitted: 2 } }),
		]);
		expect(items.map((i) => [i.run.id, i.category, i.reasons])).toEqual([
			["r1", "quality", ["handoff_missing", "gate_failed", "shortcut_flags"]],
			["r2", "quality", ["handoff_missing", "gate_not_run"]],
			["r3", "quality", ["shortcut_flags"]],
		]);
	});

	test("drops the quality signals once the PR settled or the run was re-dispatched", () => {
		const flagged = { qualityGateOutcome: "not_run" } as const;
		const items = derive(
			[
				run("open", { ...flagged, prUrl: "https://forge/pr/1", prState: "open" }),
				run("unpolled", { ...flagged, prUrl: "https://forge/pr/2", prState: null }),
				run("merged", { ...flagged, prUrl: "https://forge/pr/3", prState: "merged" }),
				run("closed", { ...flagged, prUrl: "https://forge/pr/4", prState: "closed_unmerged" }),
				run("rerun", flagged),
			],
			{ redispatched: ["rerun"] },
		);
		expect(items.map((i) => i.run.id)).toEqual(["open", "unpolled"]);
	});

	test("lists an open PR whose review asks for changes once, on its newest run", () => {
		const checks = (state: "approved" | "changes_requested" | "pending") => ({
			state: "passing" as const,
			failing: [],
			commit: "abc",
			checkedAt: "2026-11-20T10:00:00.000Z",
			review: { state, description: "Changes requested (fix rounds ran out)" },
		});
		const onPr = (id: string, pr: number, prState: "open" | "merged" | null, review = checks) => ({
			prUrl: `https://forge/pr/${pr}`,
			prState,
			prChecks: review("changes_requested"),
			id,
		});
		const items = derive([
			run("fixer", onPr("fixer", 1, "open")),
			run("builder", onPr("builder", 1, "open")),
			run("unpolled", onPr("unpolled", 2, null)),
			run("merged", onPr("merged", 3, "merged")),
			run("approved", {
				prUrl: "https://forge/pr/4",
				prState: "open",
				prChecks: checks("approved"),
			}),
			run("pending", { prUrl: "https://forge/pr/5", prState: "open", prChecks: checks("pending") }),
		]);
		expect(items.map((i) => [i.run.id, i.category, i.reasons])).toEqual([
			["fixer", "review", ["changes_requested"]],
			["unpolled", "review", ["changes_requested"]],
		]);
	});

	test("groups the items blocked, review, failed, quality, keeping newest first in each", () => {
		const review = {
			prUrl: "https://forge/pr/9",
			prState: "open" as const,
			prChecks: {
				state: "passing" as const,
				failing: [],
				commit: "abc",
				checkedAt: "2026-11-20T10:00:00.000Z",
				review: { state: "changes_requested" as const, description: null },
			},
		};
		const items = derive(
			[
				run("quality-new", { qualityGateOutcome: "failed" }),
				run("failed-new", { state: "failed" }),
				run("review", review),
				run("blocked"),
				run("failed-old", { state: "failed" }),
				run("quality-old", { qualityGateOutcome: "not_run" }),
			],
			{ needsInput: ["blocked"] },
		);
		expect(items.map((i) => i.run.id)).toEqual([
			"blocked",
			"review",
			"failed-new",
			"failed-old",
			"quality-new",
			"quality-old",
		]);
	});

	test("ignores the facts that ask nothing of the operator", () => {
		const items = derive([
			run("r1", { qualityGateOutcome: "passed", qualityFlags: { flags: [], omitted: 0 } }),
			run("r2", { qualityGateOutcome: "stale" }),
			run("r3", { qualityGateOutcome: "unknown" }),
			run("r4", { qualityGateOutcome: "unconfigured" }),
			run("r5", { state: "cancelled", qualityGateOutcome: "not_run" }),
		]);
		expect(items).toEqual([]);
	});
});

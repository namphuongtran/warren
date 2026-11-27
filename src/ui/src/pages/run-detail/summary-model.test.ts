import { describe, expect, test } from "bun:test";
import type { JudgeStoreRow } from "../telemetry/judge-verdicts.ts";
import {
	changesLink,
	evidenceHref,
	findRunJudgeRow,
	handoffStatusView,
	prChecksView,
	prReviewView,
	pullRequestTone,
	pushedBranch,
	qualityFlagHref,
	qualityFlagsView,
	qualityGateView,
	readRunDetailView,
} from "./summary-model.ts";

describe("readRunDetailView", () => {
	test("opens the Summary tab when the URL names no tab", () => {
		expect(readRunDetailView(new URLSearchParams(""))).toEqual({ tab: "summary", seqRange: null });
	});

	test("opens the Activity tab when the URL asks for it", () => {
		expect(readRunDetailView(new URLSearchParams("tab=activity")).tab).toBe("activity");
	});

	test("falls back to Summary for an unknown tab", () => {
		expect(readRunDetailView(new URLSearchParams("tab=bogus")).tab).toBe("summary");
	});

	test("reads an evidence range and opens Activity for it", () => {
		expect(readRunDetailView(new URLSearchParams("seq=12-18"))).toEqual({
			tab: "activity",
			seqRange: { fromSeq: 12, toSeq: 18 },
		});
	});

	test("reads a single sequence number as a one-event range", () => {
		expect(readRunDetailView(new URLSearchParams("tab=activity&seq=7")).seqRange).toEqual({
			fromSeq: 7,
			toSeq: 7,
		});
	});

	test("ignores a malformed or backwards range", () => {
		for (const seq of ["abc", "9-3", "-1", "1-", "1.5-2", ""]) {
			expect(readRunDetailView(new URLSearchParams(`tab=activity&seq=${seq}`)).seqRange).toBeNull();
		}
	});
});

describe("evidenceHref", () => {
	test("points at the run's Activity tab with the range highlighted", () => {
		expect(evidenceHref("run_abc", { fromSeq: 12, toSeq: 18 })).toBe(
			"/runs/run_abc?tab=activity&seq=12-18",
		);
	});

	test("writes a one-event range as a single number", () => {
		expect(evidenceHref("run_abc", { fromSeq: 7, toSeq: 7 })).toBe(
			"/runs/run_abc?tab=activity&seq=7",
		);
	});

	test("round-trips through readRunDetailView", () => {
		const href = evidenceHref("run_abc", { fromSeq: 3, toSeq: 40 });
		const params = new URLSearchParams(href.split("?")[1]);
		expect(readRunDetailView(params).seqRange).toEqual({ fromSeq: 3, toSeq: 40 });
	});
});

function judgeRow(
	id: number,
	runId: string,
	kind: "verdict" | "unjudged" = "verdict",
): JudgeStoreRow {
	return {
		id,
		kind,
		runId,
		rubricVersion: "sha256:fx",
		judgeModelId: "claude-haiku-4-5",
		verdict: null,
		reason: kind === "unjudged" ? "transcript_too_short" : null,
		detail: null,
	};
}

describe("findRunJudgeRow", () => {
	test("returns null when the judge has not scored the run", () => {
		expect(findRunJudgeRow([judgeRow(1, "run_other")], "run_abc")).toBeNull();
	});

	test("returns the newest row for the run when it was judged twice", () => {
		const rows = [judgeRow(3, "run_other"), judgeRow(2, "run_abc"), judgeRow(5, "run_abc")];
		expect(findRunJudgeRow(rows, "run_abc")?.id).toBe(5);
	});

	test("returns an unjudged marker so the page can say why", () => {
		expect(findRunJudgeRow([judgeRow(4, "run_abc", "unjudged")], "run_abc")?.kind).toBe("unjudged");
	});
});

describe("changesLink", () => {
	const base = {
		prUrl: null,
		baseSha: "4be1f2a9c0d3e5f60718293a4b5c6d7e8f901234",
		branch: "warren/run_abc",
		targetBranch: null,
	};

	test("opens the PR's files view when the run opened a GitHub PR", () => {
		const run = { ...base, prUrl: "https://github.com/acme/app/pull/12" };
		expect(changesLink(run, "https://github.com/acme/app")).toEqual({
			href: "https://github.com/acme/app/pull/12/files",
			label: "Files on the PR",
		});
	});

	test("opens a non-GitHub PR as it is", () => {
		const run = { ...base, prUrl: "https://dev.azure.com/acme/app/_git/app/pullrequest/9" };
		expect(changesLink(run, null)?.href).toBe(
			"https://dev.azure.com/acme/app/_git/app/pullrequest/9",
		);
	});

	test("builds a GitHub compare view from the base commit to the pushed branch", () => {
		expect(changesLink(base, "https://github.com/acme/app.git")).toEqual({
			href: "https://github.com/acme/app/compare/4be1f2a9c0d3e5f60718293a4b5c6d7e8f901234...warren/run_abc",
			label: "Compare on GitHub",
		});
	});

	test("reads an SSH remote and prefers the target branch reap pushed to", () => {
		const run = { ...base, targetBranch: "feat/x" };
		expect(changesLink(run, "git@github.com:acme/app.git")?.href).toBe(
			"https://github.com/acme/app/compare/4be1f2a9c0d3e5f60718293a4b5c6d7e8f901234...feat/x",
		);
	});

	test("returns null without a PR, a base commit, a branch, or a GitHub remote", () => {
		expect(changesLink({ ...base, baseSha: null }, "https://github.com/acme/app")).toBeNull();
		expect(changesLink({ ...base, branch: null }, "https://github.com/acme/app")).toBeNull();
		expect(changesLink(base, "https://gitlab.com/acme/app")).toBeNull();
		expect(changesLink(base, undefined)).toBeNull();
	});
});

describe("qualityGateView", () => {
	test("says the outcome lands at reap while the run is still live", () => {
		expect(qualityGateView(null, false)).toEqual({
			label: "Pending",
			tone: "neutral",
			detail: "Warren reads the gate outcome when the run finishes.",
		});
	});

	test("says nothing was recorded for a finished run without an outcome", () => {
		expect(qualityGateView(null, true).label).toBe("Not recorded");
	});

	test("flags a pass followed by more edits as a warning", () => {
		const view = qualityGateView("stale", true);
		expect(view.tone).toBe("warning");
		expect(view.label).toBe("Stale");
	});

	test("reads a pass as success and a failure as danger", () => {
		expect(qualityGateView("passed", true).tone).toBe("success");
		expect(qualityGateView("failed", true).tone).toBe("danger");
	});
});

describe("qualityFlagsView", () => {
	test("reads a null record as pending on a live run", () => {
		expect(qualityFlagsView(null, false).label).toBe("Pending");
	});

	test("reads a null record as not scanned on a finished run", () => {
		expect(qualityFlagsView(null, true)).toMatchObject({ label: "Not scanned", tone: "neutral" });
	});

	test("reads an empty scan as none found", () => {
		expect(qualityFlagsView({ flags: [], omitted: 0 }, true)).toMatchObject({
			label: "None found",
			tone: "success",
		});
	});

	test("counts the flags, including the ones past the cap", () => {
		const flag = { kind: "suppression", path: "a.ts", line: 1, detail: "noqa" } as const;
		expect(qualityFlagsView({ flags: [flag, flag], omitted: 3 }, true)).toMatchObject({
			label: "5 flags",
			tone: "warning",
		});
		expect(qualityFlagsView({ flags: [flag], omitted: 0 }, true).label).toBe("1 flag");
	});
});

describe("qualityFlagHref", () => {
	const run = {
		baseSha: "b".repeat(40),
		branch: "agent/bot/run-1",
		targetBranch: null,
		prChecks: null,
	};
	const remote = "https://github.com/acme/app.git";

	test("links a line flag to the file at that line on the pushed branch", () => {
		const flag = { kind: "suppression", path: "src/a b.ts", line: 12, detail: "noqa" } as const;
		expect(qualityFlagHref(run, remote, flag)).toBe(
			"https://github.com/acme/app/blob/agent/bot/run-1/src/a%20b.ts#L12",
		);
	});

	test("prefers the PR head commit, which outlives a branch deleted on merge", () => {
		const head = "c".repeat(40);
		const checks = { state: "passing", failing: [], commit: head, checkedAt: "" } as const;
		const flag = { kind: "suppression", path: "a.ts", line: 3, detail: "noqa" } as const;
		expect(qualityFlagHref({ ...run, prChecks: checks }, remote, flag)).toBe(
			`https://github.com/acme/app/blob/${head}/a.ts#L3`,
		);
	});

	test("links a deleted test file at the base commit, where it still exists", () => {
		const flag = { kind: "deleted_test", path: "t/x.test.ts", line: null, detail: "" } as const;
		expect(qualityFlagHref(run, remote, flag)).toBe(
			`https://github.com/acme/app/blob/${"b".repeat(40)}/t/x.test.ts`,
		);
	});

	test("gives no link for a command flag or a remote off GitHub", () => {
		const command = { kind: "hook_bypass", path: null, line: null, detail: "git" } as const;
		const file = { kind: "protected_file", path: "a.json", line: null, detail: "*.json" } as const;
		expect(qualityFlagHref(run, remote, command)).toBeNull();
		expect(qualityFlagHref(run, "https://gitlab.com/acme/app.git", file)).toBeNull();
	});
});

describe("handoffStatusView", () => {
	test("reads the agent's own status into a tone", () => {
		expect(handoffStatusView("done")).toEqual({ label: "Done", tone: "success" });
		expect(handoffStatusView("partial")).toEqual({ label: "Partial", tone: "warning" });
		expect(handoffStatusView("blocked")).toEqual({ label: "Blocked", tone: "danger" });
	});
});

describe("pushedBranch", () => {
	test("prefers the existing branch reap pushed to over the composed run branch", () => {
		expect(pushedBranch({ targetBranch: "feat/x", branch: "warren/run_abc" })).toBe("feat/x");
		expect(pushedBranch({ targetBranch: null, branch: "warren/run_abc" })).toBe("warren/run_abc");
		expect(pushedBranch({ targetBranch: null, branch: null })).toBeNull();
	});
});

describe("pullRequestTone", () => {
	test("reads merged as success, open as waiting, closed as a loss, unknown as neutral", () => {
		expect(pullRequestTone("merged")).toBe("success");
		expect(pullRequestTone("open")).toBe("warning");
		expect(pullRequestTone("closed_unmerged")).toBe("danger");
		expect(pullRequestTone(null)).toBe("neutral");
	});
});

describe("prChecksView", () => {
	const read = {
		failing: [] as string[],
		commit: "a".repeat(40),
		checkedAt: "2026-11-21T10:00:00.000Z",
	};

	test("flags failing checks as danger and says how many failed", () => {
		expect(prChecksView({ ...read, state: "failing", failing: ["e2e", "lint"] })).toEqual({
			label: "Failing",
			tone: "danger",
			detail: "2 checks failed on the pull request's head commit.",
		});
	});

	test("names a passing, a running, and a check-less head", () => {
		expect(prChecksView({ ...read, state: "passing" })).toMatchObject({
			label: "Passing",
			tone: "success",
		});
		expect(prChecksView({ ...read, state: "pending" })).toMatchObject({
			label: "Running",
			tone: "warning",
		});
		expect(prChecksView({ ...read, state: "none" })).toMatchObject({
			label: "No checks",
			tone: "neutral",
		});
	});

	test("counts the failures already in while other checks still run", () => {
		expect(prChecksView({ ...read, state: "pending", failing: ["e2e"] }).detail).toBe(
			"1 check failed so far; the rest are still running.",
		);
	});

	test("says the checks have not been read yet", () => {
		expect(prChecksView(null)).toEqual({
			label: "Not read yet",
			tone: "neutral",
			detail: "Warren reads the checks each time it polls the pull request.",
		});
	});
});

describe("prReviewView", () => {
	const read = {
		state: "passing" as const,
		failing: [] as string[],
		commit: "a".repeat(40),
		checkedAt: "2026-11-21T10:00:00.000Z",
	};

	test("shows the reviewer's own words for a change request", () => {
		expect(
			prReviewView({
				...read,
				review: {
					state: "changes_requested",
					description: "Changes requested (fix round 1 of 2)",
				},
			}),
		).toEqual({
			label: "Changes requested",
			tone: "danger",
			detail: "Changes requested (fix round 1 of 2)",
		});
	});

	test("explains each verdict when the status carries no description", () => {
		const view = (state: "approved" | "pending" | "failed") =>
			prReviewView({ ...read, review: { state, description: null } });
		expect(view("approved")).toEqual({
			label: "Approved",
			tone: "success",
			detail: "The reviewer approved the pull request's head commit.",
		});
		expect(view("pending")).toMatchObject({ label: "In review", tone: "warning" });
		expect(view("failed")).toMatchObject({ label: "Review failed", tone: "danger" });
	});

	test("says honestly when no review was published or the PR was not read yet", () => {
		expect(prReviewView(read)).toEqual({
			label: "No review",
			tone: "neutral",
			detail:
				"No review verdict on the pull request's head commit, or this forge credential cannot read commit statuses.",
		});
		expect(prReviewView(null)).toMatchObject({ label: "Not read yet", tone: "neutral" });
	});
});

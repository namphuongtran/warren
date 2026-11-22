import { describe, expect, test } from "bun:test";
import {
	neutralizeMentions,
	type ReviewCommentSeat,
	renderReviewComment,
	renderReviewPrompt,
} from "./render.ts";
import {
	parseReviewVerdict,
	REVIEW_VERDICT_CLOSE,
	REVIEW_VERDICT_OPEN,
	type ReviewVerdict,
} from "./verdict.ts";

const SHA = "a".repeat(40);
const PRIMARY = { agent: "reviewer", provider: "openai", model: "gpt-5.3-codex" };

/** A lone seat that returned `verdict`. */
function soleSeat(verdict: ReviewVerdict): ReviewCommentSeat[] {
	return [
		{
			identity: PRIMARY,
			state: verdict.verdict === "approve" ? "approved" : "changes_requested",
			verdict,
			failureReason: null,
		},
	];
}

describe("renderReviewPrompt", () => {
	test("pins the reviewed commit and restates the verdict grammar the parser reads", () => {
		const prompt = renderReviewPrompt({
			upstream: "acme/widgets",
			prNumber: 7,
			headSha: SHA,
			headBranch: "warren/issue-42",
			baseRef: "main",
			baseSha: "b".repeat(40),
			issueRef: "issue://42",
		});
		expect(prompt).toContain(`Reviewed commit: ${SHA}`);
		expect(prompt).toContain(`git diff ${"b".repeat(40)}...${SHA}`);
		expect(prompt).toContain(REVIEW_VERDICT_OPEN);
		expect(prompt).toContain(REVIEW_VERDICT_CLOSE);
		expect(prompt).toContain("You are read-only.");
	});
});

describe("neutralizeMentions", () => {
	test("breaks @mentions so posted agent text pings nobody", () => {
		expect(neutralizeMentions("cc @octocat and me@example")).toBe("cc @​octocat and me@​example");
	});
});

describe("renderReviewComment", () => {
	function changes(findings: unknown[]): ReturnType<typeof parseReviewVerdict> {
		return parseReviewVerdict(
			`${REVIEW_VERDICT_OPEN}${JSON.stringify({ verdict: "request_changes", summary: "Ping @lead.", findings })}${REVIEW_VERDICT_CLOSE}`,
		);
	}

	test("names the reviewer, the SHA, and each finding with its location", () => {
		const parsed = changes([
			{ title: "Off by one", body: "Fix the loop.", path: "src/a.ts", line: 3 },
		]);
		if (!parsed.ok) throw new Error("fixture verdict did not parse");
		const body = renderReviewComment({
			verdict: parsed.verdict,
			headSha: SHA,
			round: 1,
			seats: soleSeat(parsed.verdict),
			maxRounds: 2,
			needsHuman: false,
		});
		expect(body).toContain("### Warren review: changes requested");
		expect(body).toContain(`\`${SHA}\``);
		expect(body).toContain("`reviewer` on `openai/gpt-5.3-codex`");
		expect(body).toContain("1. **Off by one** (`src/a.ts:3`)");
		expect(body).toContain("   Fix the loop.");
		expect(body).toContain("Ping @​lead.");
		expect(body).not.toContain("A human needs to take this over");
	});

	test("keeps an untrusted path and title from breaking out of their markdown", () => {
		const parsed = changes([
			{ title: "Bad\n## Fake heading", body: "b", path: "src/x.ts` [click](http://evil)" },
		]);
		if (!parsed.ok) throw new Error("fixture verdict did not parse");
		const body = renderReviewComment({
			verdict: parsed.verdict,
			headSha: SHA,
			round: 2,
			seats: soleSeat(parsed.verdict),
			maxRounds: 2,
			needsHuman: true,
		});
		expect(body).toContain("1. **Bad ## Fake heading** (`src/x.ts [click](http://evil)`)");
		expect(body).toContain(
			"The fix loop stopped after 2 round(s). A human needs to take this over.",
		);
	});

	test("renders a panel as one section per reviewer under the decided verdict", () => {
		const approve: ReviewVerdict = { verdict: "approve", summary: "Fine by me.", findings: [] };
		const dissent: ReviewVerdict = {
			verdict: "request_changes",
			summary: "One concern.",
			findings: [{ title: "Race", body: "Lock the map.", path: "src/m.ts", line: 9 }],
		};
		const body = renderReviewComment({
			verdict: {
				verdict: "approve",
				summary: "2 of 3 reviewers approved (quorum 2).",
				findings: [],
			},
			headSha: SHA,
			round: 1,
			seats: [
				{ identity: PRIMARY, state: "approved", verdict: approve, failureReason: null },
				{
					identity: { agent: "reviewer", provider: "anthropic", model: null },
					state: "changes_requested",
					verdict: dissent,
					failureReason: null,
				},
				{
					identity: { agent: "codex", provider: null, model: null },
					state: "failed",
					verdict: null,
					failureReason: "run_failed",
				},
			],
			maxRounds: 2,
			needsHuman: false,
		});
		expect(body).toContain("### Warren review: approved");
		expect(body).toContain("2 of 3 reviewers approved (quorum 2).");
		expect(body).toContain("#### Reviewer 1: `reviewer` on `openai/gpt-5.3-codex` (approved)");
		expect(body).toContain("#### Reviewer 2: `reviewer` on `anthropic` (changes requested)");
		expect(body).toContain("1. **Race** (`src/m.ts:9`)");
		expect(body).toContain("#### Reviewer 3: `codex` (no verdict: run_failed)");
	});
});

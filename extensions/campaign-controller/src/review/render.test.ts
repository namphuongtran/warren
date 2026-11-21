import { describe, expect, test } from "bun:test";
import type { ReviewPolicy } from "../repository-policy.ts";
import { neutralizeMentions, renderReviewComment, renderReviewPrompt } from "./render.ts";
import { parseReviewVerdict, REVIEW_VERDICT_CLOSE, REVIEW_VERDICT_OPEN } from "./verdict.ts";

const SHA = "a".repeat(40);
const REVIEW: ReviewPolicy = {
	version: 1,
	agent: "reviewer",
	provider: "openai",
	model: "gpt-5.3-codex",
	statusContext: "warren/review",
	maxRounds: 2,
	maxCostUsd: 2,
};

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
			review: REVIEW,
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
			review: REVIEW,
			needsHuman: true,
		});
		expect(body).toContain("1. **Bad ## Fake heading** (`src/x.ts [click](http://evil)`)");
		expect(body).toContain(
			"The fix loop stopped after 2 round(s). A human needs to take this over.",
		);
	});
});

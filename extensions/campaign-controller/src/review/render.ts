/**
 * Pure renderers for the cross-model review policy (namphuongtran/warren#18): the reviewer
 * dispatch prompt and the PR review comment. No I/O, no clock.
 */
import type { ReviewPolicy } from "../repository-policy.ts";
import { REVIEW_VERDICT_CLOSE, REVIEW_VERDICT_OPEN, type ReviewVerdict } from "./verdict.ts";

export interface ReviewPromptInput {
	readonly upstream: string;
	readonly prNumber: number;
	readonly headSha: string;
	readonly headBranch: string;
	readonly baseRef: string | null;
	readonly baseSha: string | null;
	readonly issueRef: string;
}

/** The reviewer dispatch prompt. It restates the verdict grammar so any agent can serve. */
export function renderReviewPrompt(input: ReviewPromptInput): string {
	const diffHint =
		input.baseSha !== null
			? `Review the change \`git diff ${input.baseSha}...${input.headSha}\`. If the base commit is missing locally, review the commits on this branch since it left ${input.baseRef ?? "the default branch"}.`
			: `Review the commits on this branch since it left ${input.baseRef ?? "the default branch"}.`;
	return [
		`You are an independent code reviewer for pull request #${input.prNumber} in ${input.upstream}.`,
		"",
		`Issue: ${input.issueRef}`,
		`Head branch: ${input.headBranch}`,
		`Reviewed commit: ${input.headSha} (the workspace is checked out at exactly this commit)`,
		"",
		diffHint,
		"",
		"You are read-only. Do not edit files, commit, push, or open pull requests.",
		"Report real defects only: bugs, missing tests for changed behavior, security problems,",
		"and violations of the repository's documented conventions. Skip style nits.",
		"",
		"End your final message with exactly one verdict block, and nothing after it:",
		"",
		REVIEW_VERDICT_OPEN,
		'{"verdict":"approve"|"request_changes","summary":"<one paragraph>",',
		' "findings":[{"title":"<short>","body":"<what is wrong and how to fix it>","path":"<file>","line":<n>}]}',
		REVIEW_VERDICT_CLOSE,
		"",
		"Use request_changes only with at least one finding. path and line are optional.",
	].join("\n");
}

/** One line, no backticks: safe inside an inline code span or a list item. */
function inlineSafe(text: string): string {
	return text.replace(/`/g, " ").replace(/\s+/g, " ").trim();
}

/** Break `@user` mentions so posting agent text never pings anyone. */
export function neutralizeMentions(text: string): string {
	return text.replace(/@(?=[A-Za-z0-9])/g, "@\u200b");
}

export interface ReviewCommentInput {
	readonly verdict: ReviewVerdict;
	readonly headSha: string;
	readonly round: number;
	readonly review: ReviewPolicy;
	/** True when this change request hands the PR to a human. */
	readonly needsHuman: boolean;
}

/** The PR review comment body: verdict, reviewer identity, summary, findings. */
export function renderReviewComment(input: ReviewCommentInput): string {
	const { verdict, review } = input;
	const reviewer = [review.provider, review.model].filter((part) => part !== null).join("/");
	const heading =
		verdict.verdict === "approve" ? "Warren review: approved" : "Warren review: changes requested";
	const lines = [
		`### ${heading}`,
		"",
		`Reviewed commit \`${input.headSha}\` (round ${input.round}) with \`${review.agent}\`${reviewer !== "" ? ` on \`${reviewer}\`` : ""}.`,
		"",
		neutralizeMentions(verdict.summary),
	];
	if (verdict.findings.length > 0) {
		lines.push("", "**Findings**", "");
		verdict.findings.forEach((finding, index) => {
			const where =
				finding.path !== null
					? ` (\`${inlineSafe(finding.path)}${finding.line !== null ? `:${finding.line}` : ""}\`)`
					: "";
			lines.push(`${index + 1}. **${neutralizeMentions(inlineSafe(finding.title))}**${where}`);
			for (const bodyLine of neutralizeMentions(finding.body).split("\n")) {
				lines.push(`   ${bodyLine}`);
			}
		});
	}
	if (input.needsHuman) {
		lines.push(
			"",
			`The fix loop stopped after ${review.maxRounds} round(s). A human needs to take this over.`,
		);
	}
	lines.push("", "_Automated review. The commit status on this SHA is the merge gate._");
	return lines.join("\n");
}

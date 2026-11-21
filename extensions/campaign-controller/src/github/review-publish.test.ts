import { describe, expect, test } from "bun:test";
import { BoundaryError, ValidationError } from "../errors.ts";
import { NO_MUTATIONS } from "../mutations.ts";
import { validateRepositoryPolicy } from "../repository-policy.ts";
import type { FetchLike } from "./http-transport.ts";
import {
	BunFetchGithubReviewPublisher,
	renderCommitStatusIntent,
	renderPullRequestReviewIntent,
} from "./review-publish.ts";

const NOW = Date.parse("2026-08-27T00:00:00.000Z");
const TOKEN = "ghp_review-token-value-456";
const SHA = "0123456789abcdef0123456789abcdef01234567";

function policy(review: boolean) {
	return validateRepositoryPolicy(
		{
			schemaVersion: 1,
			profileId: "openclaw",
			upstream: { owner: "openclaw", repo: "openclaw" },
			source: {
				url: "https://raw.githubusercontent.com/openclaw/openclaw/main/CONTRIBUTING.md",
				fetchedAt: "2026-08-26T00:00:00.000Z",
				sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
			},
			stalenessMaxDays: 90,
			issueFirstRequired: true,
			aiDisclosure: { required: true, evidenceRequired: true },
			allowedWorkTypes: ["bug-fix"],
			forbiddenPaths: [".github/workflows/*"],
			protectedPaths: [],
			upstreamObservedMaxOpenPrs: 20,
			maxOpenPrs: 5,
			maxNewPrsPerDay: 2,
			requiredChecks: ["ci"],
			mutations: { ...NO_MUTATIONS },
			...(review ? { review: { version: 1, agent: "reviewer", maxRounds: 2, maxCostUsd: 1 } } : {}),
		},
		{ nowMs: NOW },
	).policy;
}

function recordingFetch() {
	const calls: Array<{ url: string; method: string; auth: string | undefined; body: unknown }> = [];
	const fetchImpl: FetchLike = async (url, init) => {
		const headers = (init?.headers ?? {}) as Record<string, string>;
		calls.push({
			url: String(url),
			method: String(init?.method),
			auth: headers.authorization,
			body: JSON.parse(String(init?.body)),
		});
		return new Response(JSON.stringify({ id: 99 }), { status: 201 });
	};
	return { calls, fetchImpl };
}

describe("BunFetchGithubReviewPublisher", () => {
	test("refuses to exist without a review block in the policy", () => {
		expect(
			() => new BunFetchGithubReviewPublisher({ policy: policy(false), token: TOKEN }),
		).toThrow(BoundaryError);
	});

	test("posts the commit status to the policy upstream with the bearer credential", async () => {
		const { calls, fetchImpl } = recordingFetch();
		const publisher = new BunFetchGithubReviewPublisher({
			policy: policy(true),
			token: TOKEN,
			fetchImpl,
		});
		const result = await publisher.postCommitStatus(
			renderCommitStatusIntent({
				upstreamOwner: "openclaw",
				upstreamRepo: "openclaw",
				sha: SHA,
				state: "success",
				context: "warren/review",
				description: "Approved by the reviewer",
			}),
		);
		expect(result).toEqual({ statusId: 99 });
		expect(calls).toEqual([
			{
				url: `https://api.github.com/repos/openclaw/openclaw/statuses/${SHA}`,
				method: "POST",
				auth: `Bearer ${TOKEN}`,
				body: {
					state: "success",
					context: "warren/review",
					description: "Approved by the reviewer",
				},
			},
		]);
	});

	test("refuses an intent aimed at another repository before sending", async () => {
		const { calls, fetchImpl } = recordingFetch();
		const publisher = new BunFetchGithubReviewPublisher({
			policy: policy(true),
			token: TOKEN,
			fetchImpl,
		});
		const foreign = renderPullRequestReviewIntent({
			upstreamOwner: "someone",
			upstreamRepo: "else",
			prNumber: 3,
			sha: SHA,
			body: "hi",
		});
		await expect(publisher.postPullRequestReview(foreign)).rejects.toThrow(BoundaryError);
		expect(calls).toHaveLength(0);
	});
});

describe("renderCommitStatusIntent", () => {
	test("rejects a non-SHA ref and clips long descriptions to 140 characters", () => {
		const base = {
			upstreamOwner: "openclaw",
			upstreamRepo: "openclaw",
			state: "failure" as const,
			context: "warren/review",
		};
		expect(() => renderCommitStatusIntent({ ...base, sha: "main", description: "x" })).toThrow(
			ValidationError,
		);
		const intent = renderCommitStatusIntent({ ...base, sha: SHA, description: "y".repeat(300) });
		expect(intent.body.description).toHaveLength(140);
	});
});

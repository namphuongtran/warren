import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { FixedClock, SequentialIdGenerator } from "../clock.ts";
import { BoundaryError } from "../errors.ts";
import type {
	CommitStatusIntent,
	GithubReviewPublisherTransport,
	PullRequestReviewIntent,
} from "../github/review-publish.ts";
import { NO_MUTATIONS } from "../mutations.ts";
import { type RepositoryPolicy, validateRepositoryPolicy } from "../repository-policy.ts";
import { CampaignStateStore } from "../store/state-store.ts";
import { WarrenClient } from "../warren-client.ts";
import { FakeWarrenServer } from "../warren-fake.ts";
import {
	REVIEW_FAILED_REASON,
	REVIEW_FEEDBACK_CATEGORY,
	REVIEW_NEEDS_HUMAN_REASON,
	REVIEW_RUN_ACTION_TYPE,
	type ReviewContext,
	ReviewCoordinator,
} from "./coordinator.ts";
import { REVIEW_VERDICT_CLOSE, REVIEW_VERDICT_OPEN } from "./verdict.ts";

const TOKEN = "warren-test-token";
const NOW = Date.parse("2026-08-26T00:00:00.000Z");
const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const SHA_C = "c".repeat(40);

function policyWith(review: Record<string, unknown> | null): RepositoryPolicy {
	return validateRepositoryPolicy(
		{
			schemaVersion: 1,
			profileId: "warren",
			upstream: { owner: "acme", repo: "widgets" },
			source: {
				url: "https://raw.githubusercontent.com/acme/widgets/main/CONTRIBUTING.md",
				fetchedAt: "2026-08-25T00:00:00.000Z",
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
			...(review !== null ? { review } : {}),
		},
		{ nowMs: NOW },
	).policy;
}

const REVIEW = {
	version: 1,
	agent: "reviewer",
	provider: "openai",
	model: "gpt-5-codex",
	maxRounds: 2,
	maxCostUsd: 2,
};

class RecordingPublisher implements GithubReviewPublisherTransport {
	readonly statuses: CommitStatusIntent[] = [];
	readonly reviews: PullRequestReviewIntent[] = [];
	rejectStatuses = false;

	async postCommitStatus(intent: CommitStatusIntent): Promise<{ statusId: number | null }> {
		if (this.rejectStatuses) {
			throw new Error("GitHub said 422");
		}
		this.statuses.push(intent);
		return { statusId: this.statuses.length };
	}

	async postPullRequestReview(
		intent: PullRequestReviewIntent,
	): Promise<{ reviewId: number | null }> {
		this.reviews.push(intent);
		return { reviewId: this.reviews.length };
	}

	statesOn(sha: string): string[] {
		return this.statuses.filter((s) => s.url.endsWith(`/statuses/${sha}`)).map((s) => s.body.state);
	}
}

function verdictText(payload: unknown): string {
	return `Review done.\n${REVIEW_VERDICT_OPEN}\n${JSON.stringify(payload)}\n${REVIEW_VERDICT_CLOSE}`;
}

const APPROVE = { verdict: "approve", summary: "Clean change.", findings: [] };
const CHANGES = {
	verdict: "request_changes",
	summary: "Two problems.",
	findings: [
		{ title: "Off by one", body: "The loop skips the last item.", path: "src/a.ts", line: 3 },
		{ title: "Missing test", body: "Cover the empty input." },
	],
};

let store: CampaignStateStore;
let fake: FakeWarrenServer;
let publisher: RecordingPublisher;
let campaignId: string;
let workItemId: string;

beforeEach(() => {
	store = new CampaignStateStore(":memory:", {
		clock: new FixedClock(NOW),
		ids: new SequentialIdGenerator(),
	});
	campaignId = store.campaigns.createCampaign({
		manifestDigest: "digest-review",
		manifestJson: "{}",
		budgetCapUsdCents: 100_00,
	}).id;
	workItemId = store.campaigns.addWorkItem({ campaignId, position: 1, issueRef: "issue://42" }).id;
	fake = new FakeWarrenServer({ token: TOKEN });
	publisher = new RecordingPublisher();
});

afterEach(() => {
	store.close();
});

function coordinator(policy: RepositoryPolicy = policyWith(REVIEW)): ReviewCoordinator {
	return new ReviewCoordinator({
		store,
		warren: new WarrenClient({
			baseUrl: "http://warren.test",
			token: TOKEN,
			fetchFn: fake.fetch,
			sleep: async () => {},
		}),
		publisher,
		policy,
	});
}

function ctx(overrides: Partial<ReviewContext> = {}): ReviewContext {
	return {
		campaignId,
		workItemId,
		issueRef: "issue://42",
		project: "acme-widgets",
		prNumber: 7,
		prOpen: true,
		headSha: SHA_A,
		headBranch: "warren/issue-42",
		budgetHeadroomUsdCents: 50_00,
		...overrides,
	};
}

/** Finish the review run for `runId` with the given verdict text. */
function finishRun(runId: string, text: string): void {
	fake.setRunEvents(runId, [
		{ seq: 1, kind: "text", stream: "stdout", payload: { text: "Reading the diff." } },
		{ seq: 2, kind: "text", stream: "stdout", payload: { text } },
	]);
	fake.setRunState(runId, { state: "succeeded", costUsd: 0.4 });
}

describe("ReviewCoordinator", () => {
	test("refuses to exist when the policy has no review block", () => {
		expect(() => coordinator(policyWith(null))).toThrow(BoundaryError);
	});

	test("dispatches a read-only reviewer pinned to the head SHA and marks it pending", async () => {
		const outcome = await coordinator().step(ctx());
		expect(outcome.status).toBe("dispatched");
		const run = fake.getRunRow(outcome.runId ?? "");
		expect(run?.agentName).toBe("reviewer");
		expect(run?.provider).toBe("openai");
		expect(run?.model).toBe("gpt-5-codex");
		expect(run?.baseCommit).toBe(SHA_A);
		expect(run?.maxCostUsd).toBe(2);
		expect(run?.prompt).toContain(SHA_A);
		expect(publisher.statuses).toEqual([
			{
				method: "POST",
				url: `/repos/acme/widgets/statuses/${SHA_A}`,
				body: { state: "pending", context: "warren/review", description: "Review in progress" },
			},
		]);
	});

	test("waits while the reviewer run is still going", async () => {
		const c = coordinator();
		await c.step(ctx());
		expect((await c.step(ctx())).status).toBe("in_progress");
		expect(fake.createdRunCount()).toBe(1);
	});

	test("publishes success and a review comment on approve, then stays settled", async () => {
		const c = coordinator();
		const first = await c.step(ctx());
		finishRun(first.runId ?? "", verdictText(APPROVE));

		const second = await c.step(ctx());
		expect(second.status).toBe("approved");
		expect(publisher.statesOn(SHA_A)).toEqual(["pending", "success"]);
		expect(publisher.reviews).toHaveLength(1);
		expect(publisher.reviews[0]?.url).toBe("/repos/acme/widgets/pulls/7/reviews");
		expect(publisher.reviews[0]?.body.commit_id).toBe(SHA_A);
		expect(publisher.reviews[0]?.body.event).toBe("COMMENT");
		expect(publisher.reviews[0]?.body.body).toContain("Clean change.");

		const third = await c.step(ctx());
		expect(third.status).toBe("settled");
		expect(publisher.statuses).toHaveLength(2);
		expect(publisher.reviews).toHaveLength(1);
		expect(fake.createdRunCount()).toBe(1);
	});

	test("on request_changes publishes failure and hands the findings to the fixer", async () => {
		const c = coordinator();
		const first = await c.step(ctx());
		finishRun(first.runId ?? "", verdictText(CHANGES));

		const second = await c.step(ctx());
		expect(second.status).toBe("changes_requested");
		expect(publisher.statesOn(SHA_A)).toEqual(["pending", "failure"]);
		expect(publisher.reviews[0]?.body.body).toContain("Off by one");
		expect(publisher.reviews[0]?.body.body).toContain("src/a.ts:3");

		const feedback = store.events.listFeedback(campaignId);
		expect(feedback.map((row) => row.category)).toEqual([
			REVIEW_FEEDBACK_CATEGORY,
			REVIEW_FEEDBACK_CATEGORY,
		]);
		expect(feedback.every((row) => row.workItemId === workItemId)).toBe(true);
		expect(JSON.parse(feedback[0]?.fieldsJson ?? "{}")).toEqual({
			title: "Off by one",
			body: "The loop skips the last item.",
			path: "src/a.ts",
			line: 3,
			headSha: SHA_A,
		});
	});

	test("voids a verdict when the head moves and re-reviews the new SHA", async () => {
		const c = coordinator();
		const onA = await c.step(ctx({ headSha: SHA_A }));

		// A push lands before the reviewer of SHA A finishes.
		const onB = await c.step(ctx({ headSha: SHA_B }));
		expect(onB.status).toBe("dispatched");
		expect(onB.runId).not.toBe(onA.runId);
		expect(fake.getRunRow(onB.runId ?? "")?.baseCommit).toBe(SHA_B);
		expect(publisher.statesOn(SHA_B)).toEqual(["pending"]);

		// The stale reviewer approves SHA A: nothing is published for it.
		finishRun(onA.runId ?? "", verdictText(APPROVE));
		finishRun(onB.runId ?? "", verdictText(CHANGES));
		const settled = await c.step(ctx({ headSha: SHA_B }));
		expect(settled.status).toBe("changes_requested");
		expect(publisher.statesOn(SHA_A)).toEqual(["pending"]);
		expect(publisher.statesOn(SHA_B)).toEqual(["pending", "failure"]);
	});

	test("a new push after an approval resets the gate to pending on the new SHA", async () => {
		const c = coordinator();
		const onA = await c.step(ctx({ headSha: SHA_A }));
		finishRun(onA.runId ?? "", verdictText(APPROVE));
		await c.step(ctx({ headSha: SHA_A }));

		const onB = await c.step(ctx({ headSha: SHA_B }));
		expect(onB.status).toBe("dispatched");
		expect(publisher.statesOn(SHA_B)).toEqual(["pending"]);
	});

	test("stops feeding the fixer after maxRounds and asks for a human", async () => {
		// maxRounds 1: the first change request reaches the fixer, the second a human.
		const c = coordinator(policyWith({ ...REVIEW, maxRounds: 1 }));
		const r1 = await c.step(ctx({ headSha: SHA_A }));
		finishRun(r1.runId ?? "", verdictText(CHANGES));
		expect((await c.step(ctx({ headSha: SHA_A }))).status).toBe("changes_requested");

		const r2 = await c.step(ctx({ headSha: SHA_B }));
		finishRun(r2.runId ?? "", verdictText(CHANGES));
		const stopped = await c.step(ctx({ headSha: SHA_B }));
		expect(stopped.status).toBe("needs_human");
		expect(stopped.round).toBe(2);
		expect(publisher.statesOn(SHA_B)).toEqual(["pending", "failure"]);
		const last = publisher.statuses.at(-1);
		expect(last?.body.description).toContain("needs a human");

		// Round 2's findings never reach the fixer.
		expect(store.events.listFeedback(campaignId)).toHaveLength(2);
		const attention = store.events.listOpenAttention(campaignId);
		expect(attention.map((row) => row.reason)).toContain(REVIEW_NEEDS_HUMAN_REASON);

		// A later human push is still reviewed, so the gate stays honest.
		expect((await c.step(ctx({ headSha: SHA_C }))).status).toBe("dispatched");
	});

	test("fails closed with an error status when the reviewer run fails", async () => {
		const c = coordinator();
		const first = await c.step(ctx());
		fake.setRunState(first.runId ?? "", { state: "failed", failureReason: "agent_error" });

		const outcome = await c.step(ctx());
		expect(outcome.status).toBe("review_failed");
		expect(publisher.statesOn(SHA_A)).toEqual(["pending", "error"]);
		expect(store.events.listOpenAttention(campaignId).map((row) => row.reason)).toEqual([
			REVIEW_FAILED_REASON,
		]);
	});

	test("fails closed when the reviewer ends without a verdict block", async () => {
		const c = coordinator();
		const first = await c.step(ctx());
		finishRun(first.runId ?? "", "I looked at it. Seems fine.");

		const outcome = await c.step(ctx());
		expect(outcome.status).toBe("review_failed");
		expect(outcome.detail).toBe("verdict_missing");
		expect(publisher.statesOn(SHA_A)).toEqual(["pending", "error"]);
		expect(publisher.reviews).toHaveLength(0);
	});

	test("defers while another attempt (a fixer run) is active on the work item", async () => {
		store.actions.beginAction({
			actionKey: "follow-up:busy",
			campaignId,
			workItemId,
			actionType: "follow_up_run",
			requestDigest: "d".repeat(64),
		});
		const outcome = await coordinator().step(ctx());
		expect(outcome.status).toBe("deferred_active_attempt");
		expect(fake.createdRunCount()).toBe(0);
		expect(publisher.statuses).toHaveLength(0);
	});

	test("refuses to dispatch without budget headroom for the review cap", async () => {
		const outcome = await coordinator().step(ctx({ budgetHeadroomUsdCents: 100 }));
		expect(outcome.status).toBe("no_budget_headroom");
		expect(fake.createdRunCount()).toBe(0);
	});

	test("recovers a crash between journaling and the dispatch POST instead of wedging", async () => {
		// The state a crash after the journal write but before the POST leaves.
		const round = store.reviews.insertDispatched({
			campaignId,
			workItemId,
			prNumber: 7,
			headSha: SHA_A,
		});
		const action = store.actions.beginAction({
			actionKey: `review:${campaignId}:${round.id}`,
			campaignId,
			actionType: REVIEW_RUN_ACTION_TYPE,
			requestDigest: "e".repeat(64),
		});
		store.actions.markExecuting(action.id);
		store.reviews.recordActionId(round.id, action.id);

		const c = coordinator();
		const recovered = await c.step(ctx({ headSha: SHA_A }));
		expect(recovered.status).toBe("review_failed");
		expect(recovered.detail).toBe("dispatch_unconfirmed");
		expect(publisher.statesOn(SHA_A)).toEqual(["error"]);
		expect(store.actions.getAction(action.id)?.state).toBe("uncertain");
		// The next push is reviewed normally.
		expect((await c.step(ctx({ headSha: SHA_B }))).status).toBe("dispatched");
	});

	test("publishes a settled verdict a crash left unpublished, exactly once", async () => {
		const c = coordinator();
		const first = await c.step(ctx());
		// A crash right after the round settled, before any write went out.
		store.reviews.settle(first.roundId ?? "", {
			state: "approved",
			verdictJson: JSON.stringify(APPROVE),
		});

		expect((await c.step(ctx())).status).toBe("settled");
		expect(publisher.statesOn(SHA_A)).toEqual(["pending", "success"]);
		expect(publisher.reviews).toHaveLength(1);

		await c.step(ctx());
		expect(publisher.statuses).toHaveLength(2);
		expect(publisher.reviews).toHaveLength(1);
	});

	test("reviews a SHA again when the head returns to it after being superseded", async () => {
		const c = coordinator();
		const onA = await c.step(ctx({ headSha: SHA_A }));
		await c.step(ctx({ headSha: SHA_B }));
		const backOnA = await c.step(ctx({ headSha: SHA_A }));
		expect(backOnA.status).toBe("dispatched");
		expect(backOnA.runId).not.toBe(onA.runId);
		expect(publisher.statesOn(SHA_A)).toEqual(["pending", "pending"]);
	});

	test("is not blocked by a journaled PR intent that never executed", async () => {
		store.actions.beginAction({
			actionKey: "pr-intent:dry-run",
			campaignId,
			workItemId,
			actionType: "pr_intent",
			requestDigest: "f".repeat(64),
		});
		expect((await coordinator().step(ctx())).status).toBe("dispatched");
	});

	test("opens an attention item when GitHub rejects a status write", async () => {
		publisher.rejectStatuses = true;
		const outcome = await coordinator().step(ctx());
		expect(outcome.status).toBe("dispatched");
		const reasons = store.events.listOpenAttention(campaignId).map((row) => row.reason);
		expect(reasons).toEqual(["mutation_failed"]);
		expect(store.events.listOpenAttention(campaignId)[0]?.workItemId).toBe(workItemId);
	});

	test("does nothing for a closed pull request", async () => {
		const outcome = await coordinator().step(ctx({ prOpen: false }));
		expect(outcome.status).toBe("pr_closed");
		expect(fake.createdRunCount()).toBe(0);
		expect(publisher.statuses).toHaveLength(0);
	});
});

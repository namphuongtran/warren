/**
 * The tick's review stage (namphuongtran/warren#18).
 *
 * Runs after the read-only GitHub reconcile, only when the validated policy
 * carries a `review` block AND a review publisher is wired (which itself
 * needs that block plus a GitHub credential). Otherwise the stage is absent
 * from the tick, off and silent.
 *
 * For each PR identity with a known upstream PR number it re-reads the pull
 * request for its current head SHA and open state, then advances the
 * review of that SHA one step through `ReviewCoordinator`. Reads are
 * GET-only; every write goes through the coordinator's journaled publisher.
 */

import type { ReadOnlyGithubClient } from "../github/client.ts";
import { GithubApiError } from "../github/errors.ts";
import type { GithubReviewPublisherTransport } from "../github/review-publish.ts";
import type { CampaignManifest } from "../manifest.ts";
import type { RepositoryPolicy } from "../repository-policy.ts";
import { ReviewCoordinator, type ReviewWarrenClient } from "../review/coordinator.ts";
import type { CampaignStateStore } from "../store/state-store.ts";
import type { CampaignRow } from "../store/types.ts";

export interface ReviewStageDeps {
	readonly store: CampaignStateStore;
	readonly warrenClient: ReviewWarrenClient;
	readonly github: ReadOnlyGithubClient;
	readonly publisher: GithubReviewPublisherTransport;
	/** The validated policy; the caller only runs the stage when `review` is set. */
	readonly policy: RepositoryPolicy;
}

/** One review-stage outcome, JSON-safe, in the tick's outcome shape. */
export interface ReviewStageOutcome {
	readonly stage: "review";
	readonly workItemId: string | null;
	readonly status: string;
	readonly detail?: unknown;
}

export async function runReviewStage(
	deps: ReviewStageDeps,
	campaign: CampaignRow,
	manifest: CampaignManifest,
): Promise<ReviewStageOutcome[]> {
	const identities = deps.store.events
		.listPrIdentities(campaign.id)
		.filter((identity) => identity.prNumber !== null);
	if (identities.length === 0) {
		return [{ stage: "review", workItemId: null, status: "none" }];
	}
	const coordinator = new ReviewCoordinator({
		store: deps.store,
		warren: deps.warrenClient,
		publisher: deps.publisher,
		policy: deps.policy,
	});
	const outcomes: ReviewStageOutcome[] = [];
	for (const identity of identities) {
		const prNumber = identity.prNumber as number;
		const pr = await readPullRequest(
			deps.github,
			identity.upstreamOwner,
			identity.upstreamRepo,
			prNumber,
		);
		if (pr === null) {
			outcomes.push({
				stage: "review",
				workItemId: identity.workItemId,
				status: "pr_missing",
				detail: { prNumber },
			});
			continue;
		}
		const item = deps.store.campaigns.getWorkItem(identity.workItemId);
		const result = await coordinator.step({
			campaignId: campaign.id,
			workItemId: identity.workItemId,
			issueRef: item?.issueRef ?? identity.workItemId,
			project: manifest.warren.project,
			prNumber,
			prOpen: pr.state === "open" && pr.mergedAt === null,
			headSha: pr.headSha,
			headBranch: pr.headRef,
			baseRef: pr.baseRef,
			baseSha: pr.baseSha,
			budgetHeadroomUsdCents: deps.store.budget.availableUsdCents(campaign.id),
		});
		outcomes.push({
			stage: "review",
			workItemId: identity.workItemId,
			status: result.status,
			detail: { prNumber, ...result },
		});
	}
	return outcomes;
}

/** One pull-request read; a 404 maps to null, a 304 without validators is impossible here. */
async function readPullRequest(
	github: ReadOnlyGithubClient,
	owner: string,
	repo: string,
	prNumber: number,
) {
	try {
		return (await github.getPullRequest(owner, repo, prNumber)).data ?? null;
	} catch (error) {
		if (error instanceof GithubApiError && error.status === 404) {
			return null;
		}
		throw error;
	}
}

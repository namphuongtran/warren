/**
 * The tick's follow-up stage: the fixer half of the review loop
 * (namphuongtran/warren#18, over the plan pl-096b follow-up coordinator).
 *
 * Present only when the validated policy enables `mutations.followUpPush`;
 * otherwise the tick has no `follow_up` outcomes at all. It runs in two
 * halves around the review stage:
 *
 * 1. **reconcile** (before review) — poll each work item's live follow-up
 *    run. A run that pushed to the PR head branch settles and marks its
 *    findings addressed, so the review stage can review the new head in the
 *    same tick. A failed run, a push elsewhere, or a dispatch with no
 *    confirmed run stops the loop for a human; nothing is re-POSTed.
 * 2. **dispatch** (after review) — for each open PR, hand the unaddressed
 *    findings raised against its current head to one follow-up run on the
 *    existing PR branch, under the campaign's approved agent identity. The
 *    review stage's `request_changes` rows therefore reach a fixer in the
 *    tick that recorded them.
 *
 * Reads are GET-only. Every journal write goes through `FollowUpCoordinator`.
 */

import {
	DEFAULT_MAX_FOLLOW_UPS_PER_PR,
	FOLLOW_UP_ACTION_TYPE,
	FollowUpCoordinator,
	FollowUpRefusal,
	followUpStoreOf,
} from "../follow-up/coordinator.ts";
import type { ReadOnlyGithubClient } from "../github/client.ts";
import type { CampaignManifest } from "../manifest.ts";
import { type RepositoryPolicy, renderAgentGuidance } from "../repository-policy.ts";
import type { CampaignStateStore } from "../store/state-store.ts";
import { type CampaignRow, TERMINAL_ACTION_STATES } from "../store/types.ts";
import {
	isTerminalRunState,
	runPushedBranch,
	type WarrenDispatchInput,
	type WarrenRunView,
} from "../warren-client.ts";
import { readPullRequest } from "./review-stage.ts";

/** The warren surface the stage consumes. `WarrenClient` satisfies it. */
export interface FollowUpWarrenClient {
	dispatchRun(input: WarrenDispatchInput): Promise<WarrenRunView>;
	getRun(id: string): Promise<WarrenRunView>;
}

export interface FollowUpStageDeps {
	readonly store: CampaignStateStore;
	readonly warrenClient: FollowUpWarrenClient;
	readonly github: ReadOnlyGithubClient;
	/** The validated policy; the caller runs the stage only when `followUpPush` is on. */
	readonly policy: RepositoryPolicy;
}

/** One follow-up-stage outcome, JSON-safe, in the tick's outcome shape. */
export interface FollowUpStageOutcome {
	readonly stage: "follow_up";
	readonly workItemId: string | null;
	readonly status: string;
	readonly detail?: unknown;
}

function coordinatorFor(deps: FollowUpStageDeps, manifest: CampaignManifest): FollowUpCoordinator {
	return new FollowUpCoordinator({
		store: followUpStoreOf(deps.store),
		dispatch: async (input) => {
			const run = await deps.warrenClient.dispatchRun({
				...input,
				...(manifest.warren.provider !== undefined ? { provider: manifest.warren.provider } : {}),
				...(manifest.warren.model !== undefined ? { model: manifest.warren.model } : {}),
			});
			return { runId: run.id };
		},
	});
}

/** Half 1: settle every live follow-up run that ended. */
export async function reconcileFollowUpRuns(
	deps: FollowUpStageDeps,
	campaign: CampaignRow,
	manifest: CampaignManifest,
): Promise<FollowUpStageOutcome[]> {
	const coordinator = coordinatorFor(deps, manifest);
	const outcomes: FollowUpStageOutcome[] = [];
	for (const item of deps.store.campaigns.listWorkItems(campaign.id)) {
		const progress = deps.store.followUps.getProgress(item.id);
		if (progress?.activeActionId == null) {
			continue;
		}
		const stop = (status: string, state: "uncertain" | "permanent_failure", reason: string) => {
			coordinator.abandonActive({
				campaignId: campaign.id,
				workItemId: item.id,
				state,
				errorClass: state === "uncertain" ? "ambiguous_response" : "run_failed",
				reason,
			});
			outcomes.push({
				stage: "follow_up",
				workItemId: item.id,
				status,
				detail: { runId: progress.runId, reason },
			});
		};
		const action = deps.store.actions.getAction(progress.activeActionId);
		if (action === null || TERMINAL_ACTION_STATES.includes(action.state)) {
			stop("stopped", "permanent_failure", "action_already_settled");
			continue;
		}
		if (progress.runId === null) {
			// A crash between journal and POST: the run may exist. Never re-POST.
			stop("dispatch_unconfirmed", "uncertain", "dispatch_unconfirmed");
			continue;
		}
		const run = await deps.warrenClient.getRun(progress.runId);
		if (!isTerminalRunState(run.state)) {
			outcomes.push({
				stage: "follow_up",
				workItemId: item.id,
				status: "in_progress",
				detail: { runId: run.id },
			});
			continue;
		}
		if (run.state !== "succeeded") {
			stop("run_failed", "permanent_failure", `run_${run.state}`);
			continue;
		}
		const pushed = coordinator.reconcilePushedFollowUp({
			workItemId: item.id,
			pushedBranch: runPushedBranch(run) ?? "",
		});
		if (pushed === null) {
			stop("run_failed", "permanent_failure", "pushed_elsewhere");
			continue;
		}
		outcomes.push({
			stage: "follow_up",
			workItemId: item.id,
			status: "pushed",
			detail: { runId: run.id, iteration: pushed.iteration },
		});
	}
	return outcomes;
}

/** Half 2: hand each open PR's actionable findings to one follow-up run. */
export async function dispatchFollowUps(
	deps: FollowUpStageDeps,
	campaign: CampaignRow,
	manifest: CampaignManifest,
): Promise<FollowUpStageOutcome[]> {
	const identities = deps.store.events
		.listPrIdentities(campaign.id)
		.filter((identity) => identity.prNumber !== null);
	const coordinator = coordinatorFor(deps, manifest);
	const guidance = renderAgentGuidance(deps.policy);
	// The review loop's own cap (`maxRounds`) must not be cut short by the
	// coordinator's default per-PR cap.
	const maxFollowUpsPerPr = Math.max(
		DEFAULT_MAX_FOLLOW_UPS_PER_PR,
		deps.policy.review?.maxRounds ?? 0,
	);
	const outcomes: FollowUpStageOutcome[] = [];
	for (const identity of identities) {
		const workItemId = identity.workItemId;
		const pr = await readPullRequest(
			deps.github,
			identity.upstreamOwner,
			identity.upstreamRepo,
			identity.prNumber as number,
		);
		if (pr === null || pr.state !== "open" || pr.mergedAt !== null) {
			outcomes.push({ stage: "follow_up", workItemId, status: "pr_not_open" });
			continue;
		}
		if (otherAttemptActive(deps.store, workItemId)) {
			outcomes.push({ stage: "follow_up", workItemId, status: "deferred_active_attempt" });
			continue;
		}
		try {
			const result = await coordinator.coordinate(
				{
					campaignId: campaign.id,
					workItemId,
					issueRef: deps.store.campaigns.getWorkItem(workItemId)?.issueRef ?? workItemId,
					project: manifest.warren.project,
					agent: manifest.warren.agent,
					headBranch: pr.headRef,
					headSha: pr.headSha,
					...(guidance !== null ? { agentGuidance: guidance } : {}),
					maxCostUsd: manifest.budget.perRunUsd,
					budgetHeadroomUsdCents: deps.store.budget.availableUsdCents(campaign.id),
				},
				{ followUpPush: deps.policy.mutations.followUpPush, maxFollowUpsPerPr },
			);
			outcomes.push({ stage: "follow_up", workItemId, status: result.status, detail: result });
		} catch (error) {
			if (!(error instanceof FollowUpRefusal)) {
				throw error;
			}
			outcomes.push({
				stage: "follow_up",
				workItemId,
				status: "refused",
				detail: { invariant: error.invariant, message: error.message },
			});
		}
	}
	return outcomes;
}

/**
 * True while a non-follow-up action (a build dispatch, a PR intent) is live
 * on the work item: the store allows one active attempt per work item, and
 * that run will move the head anyway.
 */
function otherAttemptActive(store: CampaignStateStore, workItemId: string): boolean {
	return store.actions
		.listActionsForWorkItem(workItemId)
		.some(
			(action) =>
				action.actionType !== FOLLOW_UP_ACTION_TYPE &&
				!TERMINAL_ACTION_STATES.includes(action.state),
		);
}

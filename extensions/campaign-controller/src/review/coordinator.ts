/**
 * The cross-model review coordinator (namphuongtran/warren#18).
 *
 * For a work item with an open PR, one `step` call moves the review of the
 * PR's CURRENT head SHA forward by one stage:
 *
 * 1. **No round for this SHA** → dispatch a read-only reviewer run over
 *    `POST /runs`, pinned to the SHA with `baseCommit`, under the policy's
 *    agent/provider/model and spend cap, and publish a `pending` commit
 *    status on the SHA.
 * 2. **Round live** → poll the run. When it ends, read its verdict from the
 *    run's text events and publish it: a `success`/`failure` commit status
 *    on the SHA plus a COMMENT review with the findings.
 * 3. **Round settled** → nothing to do; a re-tick never re-publishes.
 *
 * Invariants:
 *
 * - **Opt-in.** The coordinator cannot be constructed without the policy's
 *   `review` block; the tick skips the stage entirely when it is absent.
 * - **A verdict is bound to a SHA.** Rounds are unique per (work item,
 *   SHA). When the head moves, every live round on an older SHA is
 *   superseded and its verdict is never published; the new SHA gets its
 *   own round and a fresh `pending` status. Branch protection requiring the
 *   status context therefore blocks the merge until the new head is
 *   reviewed.
 * - **Fail closed.** A failed reviewer run, a missing or malformed verdict,
 *   or an unconfirmed dispatch publishes an `error` status and opens an
 *   attention item. Nothing approves by default.
 * - **Bounded fix loop.** `request_changes` findings become
 *   `review_feedback` rows the follow-up coordinator turns into fixer runs,
 *   at most `maxRounds` times per work item. The next change request
 *   publishes `failure`, opens `review_needs_human`, and feeds nothing.
 * - **Intent before I/O, resumable publishing.** The reviewer dispatch and
 *   every GitHub write are journaled as actions before the request, through
 *   the same mutation journal as the phase-3 mutations. The statuses and
 *   the comment a round owes are derived from the round's durable state, so
 *   a crash between settling a round and publishing it is repaired on the
 *   next step; an already-sent write is never re-sent.
 * - **Off the attempt ledger.** Review actions are journaled without a work
 *   item, so they never block, and are never blocked by, the store's
 *   one-active-attempt rule for build and fixer runs. A new review waits
 *   only while a run that will move the head (a build or fixer run) is live.
 */
import { canonicalJson, sha256Hex } from "../digest.ts";
import { WARREN_DISPATCH_ACTION_TYPE } from "../dispatch/dispatcher.ts";
import { BoundaryError } from "../errors.ts";
import { FOLLOW_UP_ACTION_TYPE } from "../follow-up/coordinator.ts";
import {
	type CommitStatusState,
	type GithubReviewPublisherTransport,
	type ReviewPublishIntent,
	renderCommitStatusIntent,
	renderPullRequestReviewIntent,
} from "../github/review-publish.ts";
import {
	executeJournaledMutation,
	journalMutationIntent,
	MUTATION_FAILED_REASON,
	MUTATION_UNCERTAIN_REASON,
} from "../pr-execute/mutation-journal.ts";
import type { RepositoryPolicy, ReviewPolicy } from "../repository-policy.ts";
import type { CampaignStateStore } from "../store/state-store.ts";
import { type ReviewRoundRow, TERMINAL_ACTION_STATES } from "../store/types.ts";
import {
	DispatchUncertainError,
	isTerminalRunState,
	type WarrenDispatchInput,
	type WarrenRunView,
} from "../warren-client.ts";
import { renderReviewComment, renderReviewPrompt } from "./render.ts";
import { extractReviewVerdict, type ReviewVerdict } from "./verdict.ts";

/** Action types whose live run will move the PR head; a new review waits for them. */
const HEAD_MOVING_ACTION_TYPES: ReadonlySet<string> = new Set([
	WARREN_DISPATCH_ACTION_TYPE,
	FOLLOW_UP_ACTION_TYPE,
]);

/** Action type journaled for every reviewer dispatch. */
export const REVIEW_RUN_ACTION_TYPE = "review_run";
/** Action type journaled for every review commit status. */
export const REVIEW_STATUS_ACTION_TYPE = "review_status";
/** Action type journaled for every review comment. */
export const REVIEW_COMMENT_ACTION_TYPE = "review_comment";
/** Feedback category the follow-up coordinator receives findings under. */
export const REVIEW_FEEDBACK_CATEGORY = "warren_review";
/** Attention reason: the reviewer could not produce a usable verdict. */
export const REVIEW_FAILED_REASON = "review_failed";
/** Attention reason: the fix loop hit `maxRounds`. */
export const REVIEW_NEEDS_HUMAN_REASON = "review_needs_human";

/** Events read per page, and the page ceiling, when collecting a verdict. */
const EVENTS_PAGE_SIZE = 500;
const MAX_EVENT_PAGES = 40;

/** The warren surface the coordinator consumes. `WarrenClient` satisfies it. */
export interface ReviewWarrenClient {
	dispatchRun(input: WarrenDispatchInput): Promise<WarrenRunView>;
	getRun(id: string): Promise<WarrenRunView>;
	readRunEvents(
		id: string,
		page: { since: number; limit: number },
	): Promise<Array<Record<string, unknown>>>;
}

export interface ReviewCoordinatorDeps {
	readonly store: CampaignStateStore;
	readonly warren: ReviewWarrenClient;
	readonly publisher: GithubReviewPublisherTransport;
	/** The validated policy; its `review` block must be present. */
	readonly policy: RepositoryPolicy;
}

/** Everything one step consumes about the work item and its PR. All caller-read. */
export interface ReviewContext {
	readonly campaignId: string;
	readonly workItemId: string;
	readonly issueRef: string;
	/** The warren project the reviewer runs against (the campaign's). */
	readonly project: string;
	readonly prNumber: number;
	readonly prOpen: boolean;
	readonly headSha: string;
	readonly headBranch: string;
	readonly baseRef?: string | null;
	readonly baseSha?: string | null;
	/** Campaign budget headroom in cents. */
	readonly budgetHeadroomUsdCents: number;
}

export type ReviewStepStatus =
	| "pr_closed"
	| "deferred_active_attempt"
	| "no_budget_headroom"
	| "dispatched"
	| "in_progress"
	| "approved"
	| "changes_requested"
	| "needs_human"
	| "review_failed"
	| "settled";

export interface ReviewStepOutcome {
	readonly status: ReviewStepStatus;
	readonly headSha: string;
	readonly roundId: string | null;
	readonly round: number | null;
	readonly runId: string | null;
	/** Failure reason or settled state, when there is one. */
	readonly detail: string | null;
	/** Rounds on older SHAs this step superseded. */
	readonly superseded: number;
}

export class ReviewCoordinator {
	readonly #store: CampaignStateStore;
	readonly #warren: ReviewWarrenClient;
	readonly #publisher: GithubReviewPublisherTransport;
	readonly #policy: RepositoryPolicy;
	readonly #review: ReviewPolicy;

	constructor(deps: ReviewCoordinatorDeps) {
		if (deps.policy.review === null) {
			throw new BoundaryError(
				"refusing to construct the review coordinator: the repository policy has no review block",
			);
		}
		this.#store = deps.store;
		this.#warren = deps.warren;
		this.#publisher = deps.publisher;
		this.#policy = deps.policy;
		this.#review = deps.policy.review;
	}

	/** Advance the review of the PR's current head by one stage. */
	async step(ctx: ReviewContext): Promise<ReviewStepOutcome> {
		if (!ctx.prOpen) {
			return this.#outcome(ctx, "pr_closed", null);
		}
		const superseded = this.#supersedeStale(ctx);
		const round = this.#store.reviews.getByHead(ctx.workItemId, ctx.headSha);
		if (round === null) {
			if (this.#headMovingRunActive(ctx.workItemId)) {
				return this.#outcome(ctx, "deferred_active_attempt", null, { superseded });
			}
			return { ...(await this.#dispatch(ctx)), superseded };
		}
		if (round.state === "dispatched") {
			return { ...(await this.#reconcile(ctx, round)), superseded };
		}
		// Settled: re-derive what the round owes GitHub and send anything a
		// crash left unsent. Already-sent writes are skipped by action key.
		await this.#publishRound(ctx, round);
		return this.#outcome(ctx, "settled", round, { detail: round.state, superseded });
	}

	/** A head move voids every live verdict on an older SHA. */
	#supersedeStale(ctx: ReviewContext): number {
		let count = 0;
		for (const round of this.#store.reviews.listForWorkItem(ctx.workItemId)) {
			if (round.state === "dispatched" && round.headSha !== ctx.headSha) {
				this.#store.reviews.settle(round.id, { state: "superseded", failureReason: "head_moved" });
				count += 1;
			}
		}
		return count;
	}

	async #dispatch(ctx: ReviewContext): Promise<ReviewStepOutcome> {
		const neededCents = Math.round(this.#review.maxCostUsd * 100);
		if (ctx.budgetHeadroomUsdCents < neededCents) {
			return this.#outcome(ctx, "no_budget_headroom", null, {
				detail: `review needs ${neededCents}c, campaign headroom is ${ctx.budgetHeadroomUsdCents}c`,
			});
		}
		const prompt = renderReviewPrompt({
			upstream: `${this.#policy.upstream.owner}/${this.#policy.upstream.repo}`,
			prNumber: ctx.prNumber,
			headSha: ctx.headSha,
			headBranch: ctx.headBranch,
			baseRef: ctx.baseRef ?? null,
			baseSha: ctx.baseSha ?? null,
			issueRef: ctx.issueRef,
		});
		const request: Omit<WarrenDispatchInput, "idempotencyKey"> = {
			project: ctx.project,
			agent: this.#review.agent,
			prompt,
			...(this.#review.provider !== null ? { provider: this.#review.provider } : {}),
			...(this.#review.model !== null ? { model: this.#review.model } : {}),
			maxCostUsd: this.#review.maxCostUsd,
			baseCommit: ctx.headSha,
		};
		const { round, actionId, idempotencyKey } = this.#store.transaction(() => {
			const opened = this.#store.reviews.insertDispatched({
				campaignId: ctx.campaignId,
				workItemId: ctx.workItemId,
				prNumber: ctx.prNumber,
				headSha: ctx.headSha,
			});
			// Keyed by round, not SHA: a head that returns to a superseded SHA
			// opens a new round and must dispatch a new run.
			const key = `review:${ctx.campaignId}:${opened.id}`;
			const action = this.#store.actions.beginAction({
				actionKey: key,
				campaignId: ctx.campaignId,
				actionType: REVIEW_RUN_ACTION_TYPE,
				requestDigest: sha256Hex(canonicalJson({ ...request, idempotencyKey: key })),
				reservedUsdCents: neededCents,
			});
			this.#store.actions.markExecuting(action.id);
			this.#store.reviews.recordActionId(opened.id, action.id);
			return { round: opened, actionId: action.id, idempotencyKey: key };
		});
		let run: WarrenRunView;
		try {
			run = await this.#warren.dispatchRun({ ...request, idempotencyKey });
		} catch (error) {
			// Never re-POST: an ambiguous dispatch settles uncertain, a refusal
			// settles failed, and either way the round fails closed.
			const uncertain = error instanceof DispatchUncertainError;
			this.#store.actions.settleAction(actionId, {
				state: uncertain ? "uncertain" : "permanent_failure",
				errorClass: uncertain ? "ambiguous_response" : "dispatch_rejected",
				errorJson: canonicalJson({
					message: error instanceof Error ? error.message : String(error),
				}),
			});
			return this.#fail(ctx, round, uncertain ? "dispatch_uncertain" : "dispatch_rejected");
		}
		const live = this.#store.transaction(() => {
			this.#store.actions.settleAction(actionId, { state: "succeeded", resultRunId: run.id });
			this.#store.reviews.recordRunId(round.id, run.id);
			return this.#store.reviews.getRound(round.id) as ReviewRoundRow;
		});
		await this.#publishRound(ctx, live);
		return this.#outcome(ctx, "dispatched", live);
	}

	async #reconcile(ctx: ReviewContext, round: ReviewRoundRow): Promise<ReviewStepOutcome> {
		if (round.runId === null) {
			// A crash between journal and POST: the run may or may not exist.
			const action = round.actionId !== null ? this.#store.actions.getAction(round.actionId) : null;
			if (action !== null && (action.state === "planned" || action.state === "executing")) {
				this.#store.actions.settleAction(action.id, {
					state: "uncertain",
					errorClass: "ambiguous_response",
				});
			}
			return this.#fail(ctx, round, "dispatch_unconfirmed");
		}
		const run = await this.#warren.getRun(round.runId);
		if (!isTerminalRunState(run.state)) {
			return this.#outcome(ctx, "in_progress", round);
		}
		if (run.state !== "succeeded") {
			return this.#fail(ctx, round, `run_${run.state}`);
		}
		const parsed = extractReviewVerdict(await this.#readAllEvents(round.runId));
		if (!parsed.ok) {
			return this.#fail(ctx, round, parsed.reason);
		}
		return parsed.verdict.verdict === "approve"
			? this.#approve(ctx, round, parsed.verdict)
			: this.#requestChanges(ctx, round, parsed.verdict);
	}

	async #approve(
		ctx: ReviewContext,
		round: ReviewRoundRow,
		verdict: ReviewVerdict,
	): Promise<ReviewStepOutcome> {
		const settled = this.#store.reviews.settle(round.id, {
			state: "approved",
			verdictJson: canonicalJson(verdict),
		});
		await this.#publishRound(ctx, settled);
		return this.#outcome(ctx, "approved", settled);
	}

	async #requestChanges(
		ctx: ReviewContext,
		round: ReviewRoundRow,
		verdict: ReviewVerdict,
	): Promise<ReviewStepOutcome> {
		// The fixer gets at most `maxRounds` change requests; the next one
		// goes to a human.
		const needsHuman = this.#priorChangeRequests(round) >= this.#review.maxRounds;
		const settled = this.#store.transaction(() => {
			const row = this.#store.reviews.settle(round.id, {
				state: needsHuman ? "needs_human" : "changes_requested",
				verdictJson: canonicalJson(verdict),
			});
			if (needsHuman) {
				this.#store.events.addAttentionOnce({
					campaignId: ctx.campaignId,
					workItemId: ctx.workItemId,
					reason: REVIEW_NEEDS_HUMAN_REASON,
					detailJson: canonicalJson({
						key: `review:${round.id}`,
						headSha: ctx.headSha,
						prNumber: ctx.prNumber,
						maxRounds: this.#review.maxRounds,
					}),
				});
				return row;
			}
			verdict.findings.forEach((finding, index) => {
				this.#store.events.addFeedbackOnce({
					id: `review:${round.id}:${index}`,
					campaignId: ctx.campaignId,
					workItemId: ctx.workItemId,
					category: REVIEW_FEEDBACK_CATEGORY,
					sourceEventNodeId: `warren-review:${round.runId ?? round.id}`,
					fieldsJson: canonicalJson({ ...finding, headSha: ctx.headSha }),
				});
			});
			return row;
		});
		await this.#publishRound(ctx, settled);
		return this.#outcome(ctx, needsHuman ? "needs_human" : "changes_requested", settled);
	}

	async #fail(
		ctx: ReviewContext,
		round: ReviewRoundRow,
		reason: string,
	): Promise<ReviewStepOutcome> {
		const settled = this.#store.transaction(() => {
			const row = this.#store.reviews.settle(round.id, { state: "failed", failureReason: reason });
			this.#store.events.addAttentionOnce({
				campaignId: ctx.campaignId,
				workItemId: ctx.workItemId,
				reason: REVIEW_FAILED_REASON,
				detailJson: canonicalJson({ key: `review:${round.id}`, headSha: ctx.headSha, reason }),
			});
			return row;
		});
		await this.#publishRound(ctx, settled);
		return this.#outcome(ctx, "review_failed", settled, { detail: reason });
	}

	async #readAllEvents(runId: string): Promise<Array<Record<string, unknown>>> {
		const events: Array<Record<string, unknown>> = [];
		let since = 0;
		for (let page = 0; page < MAX_EVENT_PAGES; page += 1) {
			const batch = await this.#warren.readRunEvents(runId, { since, limit: EVENTS_PAGE_SIZE });
			events.push(...batch);
			const last = batch.at(-1)?.seq;
			if (batch.length < EVENTS_PAGE_SIZE || typeof last !== "number") break;
			since = last;
		}
		return events;
	}

	/** Change-request rounds before this one (round order, so a re-derive agrees). */
	#priorChangeRequests(round: ReviewRoundRow): number {
		return this.#store.reviews
			.listForWorkItem(round.workItemId)
			.filter(
				(row) =>
					row.round < round.round &&
					(row.state === "changes_requested" || row.state === "needs_human"),
			).length;
	}

	/**
	 * Publish everything the round owes GitHub, derived from its durable
	 * state: `pending` while live, then the verdict status and (for a
	 * verdict) the review comment. Idempotent per action key.
	 */
	async #publishRound(ctx: ReviewContext, round: ReviewRoundRow): Promise<void> {
		const status = this.#statusFor(round);
		if (status === null) {
			return;
		}
		const statusIntent = renderCommitStatusIntent({
			upstreamOwner: this.#policy.upstream.owner,
			upstreamRepo: this.#policy.upstream.repo,
			sha: round.headSha,
			state: status.state,
			context: this.#review.statusContext,
			description: status.description,
		});
		await this.#journalAndSend(
			ctx,
			`review-status:${round.id}:${status.state}`,
			REVIEW_STATUS_ACTION_TYPE,
			statusIntent,
			() => this.#publisher.postCommitStatus(statusIntent),
		);
		const verdict =
			round.verdictJson !== null ? (JSON.parse(round.verdictJson) as ReviewVerdict) : null;
		if (verdict === null) {
			return;
		}
		const reviewIntent = renderPullRequestReviewIntent({
			upstreamOwner: this.#policy.upstream.owner,
			upstreamRepo: this.#policy.upstream.repo,
			prNumber: round.prNumber,
			sha: round.headSha,
			body: renderReviewComment({
				verdict,
				headSha: round.headSha,
				round: round.round,
				review: this.#review,
				needsHuman: round.state === "needs_human",
			}),
		});
		await this.#journalAndSend(
			ctx,
			`review-comment:${round.id}`,
			REVIEW_COMMENT_ACTION_TYPE,
			reviewIntent,
			() => this.#publisher.postPullRequestReview(reviewIntent),
		);
	}

	/** The commit status a round owes, or null (superseded, or not yet dispatched). */
	#statusFor(round: ReviewRoundRow): { state: CommitStatusState; description: string } | null {
		switch (round.state) {
			case "dispatched":
				return round.runId !== null
					? { state: "pending", description: "Review in progress" }
					: null;
			case "approved":
				return { state: "success", description: "Approved by the reviewer" };
			case "changes_requested":
				return {
					state: "failure",
					description: `Changes requested (fix round ${this.#priorChangeRequests(round) + 1} of ${this.#review.maxRounds})`,
				};
			case "needs_human":
				return {
					state: "failure",
					description: `Changes requested; needs a human after ${this.#review.maxRounds} fix round(s)`,
				};
			case "failed":
				return {
					state: "error",
					description: `Review failed: ${round.failureReason ?? "unknown"}`,
				};
			case "superseded":
				return null;
		}
	}

	/**
	 * Journal-then-send through the shared mutation journal, exactly once per
	 * action key. Review actions carry no work item (see the header), so the
	 * attention item for a failed or uncertain write is opened here, in the
	 * journal's own shape so the two never duplicate.
	 */
	async #journalAndSend(
		ctx: ReviewContext,
		actionKey: string,
		actionType: string,
		intent: ReviewPublishIntent,
		send: () => Promise<unknown>,
	): Promise<void> {
		const existing = this.#store.actions.getActionByKey(actionKey);
		const action =
			existing ??
			journalMutationIntent(this.#store, {
				actionKey,
				campaignId: ctx.campaignId,
				actionType,
				intent,
			}).action;
		if (existing !== null && TERMINAL_ACTION_STATES.includes(existing.state)) {
			return;
		}
		const { status } = await executeJournaledMutation(
			this.#store,
			{ campaignId: ctx.campaignId, action },
			async () => {
				await send();
				return {};
			},
		);
		const reason =
			status === "settled_failed"
				? MUTATION_FAILED_REASON
				: status === "settled_uncertain" || status === "uncertain_blocked"
					? MUTATION_UNCERTAIN_REASON
					: null;
		if (reason !== null) {
			this.#store.events.addAttentionOnce({
				campaignId: ctx.campaignId,
				workItemId: ctx.workItemId,
				reason,
				detailJson: canonicalJson({ key: `action:${action.id}`, actionId: action.id, actionType }),
			});
		}
	}

	/** True while a build or fixer run that will move the PR head is live. */
	#headMovingRunActive(workItemId: string): boolean {
		return this.#store.actions
			.listActionsForWorkItem(workItemId)
			.some(
				(row) =>
					HEAD_MOVING_ACTION_TYPES.has(row.actionType) &&
					!TERMINAL_ACTION_STATES.includes(row.state),
			);
	}

	#outcome(
		ctx: ReviewContext,
		status: ReviewStepStatus,
		round: ReviewRoundRow | null,
		extra: { runId?: string; detail?: string; superseded?: number } = {},
	): ReviewStepOutcome {
		return {
			status,
			headSha: ctx.headSha,
			roundId: round?.id ?? null,
			round: round?.round ?? null,
			runId: extra.runId ?? round?.runId ?? null,
			detail: extra.detail ?? null,
			superseded: extra.superseded ?? 0,
		};
	}
}

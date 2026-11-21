/**
 * The review-publish transport (namphuongtran/warren#18).
 *
 * The cross-model review policy publishes a reviewer's verdict two ways,
 * both with the controller's own GitHub credential (the reviewer run holds
 * none):
 *
 * - a **commit status** on the reviewed SHA (`POST /statuses/{sha}`), the
 *   signal forge branch protection gates the merge on; and
 * - a **pull-request review** with event `COMMENT`, pinned to the same SHA,
 *   carrying the summary and findings for humans.
 *
 * Same shape as the phase-3 transports in `pr-mutations.ts`: the class can
 * only be constructed from a validated policy whose `review` block is
 * present, so a policy without one leaves no object with these methods.
 * Every intent is checked against the policy upstream before the
 * credential is used.
 */

import { BoundaryError, ValidationError } from "../errors.ts";
import type { RepositoryPolicy } from "../repository-policy.ts";
import {
	type MutationTransportOptions,
	makeSend,
	readJson,
	requireToken,
	type SendFn,
} from "./pr-mutations.ts";

/** Commit-status states GitHub accepts. */
export type CommitStatusState = "pending" | "success" | "failure" | "error";

/** Status descriptions are clipped to the 140 characters GitHub shows. */
export const MAX_STATUS_DESCRIPTION_CHARS = 140;

const SHA_PATTERN = /^[0-9a-f]{40}$/;

/** POST a commit status on one SHA of the policy upstream. */
export interface CommitStatusIntent {
	method: "POST";
	/** `/repos/{owner}/{repo}/statuses/{sha}`, policy upstream only. */
	url: string;
	body: Readonly<{ state: CommitStatusState; context: string; description: string }>;
}

/** POST a COMMENT review on one policy-upstream pull request, pinned to a SHA. */
export interface PullRequestReviewIntent {
	method: "POST";
	/** `/repos/{owner}/{repo}/pulls/{number}/reviews`, policy upstream only. */
	url: string;
	body: Readonly<{ commit_id: string; event: "COMMENT"; body: string }>;
}

export type ReviewPublishIntent = CommitStatusIntent | PullRequestReviewIntent;

export function renderCommitStatusIntent(input: {
	upstreamOwner: string;
	upstreamRepo: string;
	sha: string;
	state: CommitStatusState;
	context: string;
	description: string;
}): CommitStatusIntent {
	requireSha(input.sha);
	const description = input.description.slice(0, MAX_STATUS_DESCRIPTION_CHARS);
	return Object.freeze({
		method: "POST" as const,
		url: `/repos/${input.upstreamOwner}/${input.upstreamRepo}/statuses/${input.sha}`,
		body: Object.freeze({ state: input.state, context: input.context, description }),
	});
}

export function renderPullRequestReviewIntent(input: {
	upstreamOwner: string;
	upstreamRepo: string;
	prNumber: number;
	sha: string;
	body: string;
}): PullRequestReviewIntent {
	requireSha(input.sha);
	if (!Number.isInteger(input.prNumber) || input.prNumber < 1) {
		throw new ValidationError(`prNumber must be a positive integer, got ${String(input.prNumber)}`);
	}
	if (input.body.trim() === "") {
		throw new ValidationError("review body must be a non-empty string");
	}
	return Object.freeze({
		method: "POST" as const,
		url: `/repos/${input.upstreamOwner}/${input.upstreamRepo}/pulls/${input.prNumber}/reviews`,
		body: Object.freeze({ commit_id: input.sha, event: "COMMENT" as const, body: input.body }),
	});
}

function requireSha(sha: string): void {
	if (!SHA_PATTERN.test(sha)) {
		throw new ValidationError(`expected a 40-character lowercase hex commit SHA, got '${sha}'`);
	}
}

/** The seam the review coordinator consumes. */
export interface GithubReviewPublisherTransport {
	postCommitStatus(intent: CommitStatusIntent): Promise<{ statusId: number | null }>;
	postPullRequestReview(intent: PullRequestReviewIntent): Promise<{ reviewId: number | null }>;
}

export class BunFetchGithubReviewPublisher implements GithubReviewPublisherTransport {
	readonly #policy: RepositoryPolicy;
	readonly #send: SendFn;

	constructor(options: MutationTransportOptions) {
		if (options.policy.review === null) {
			throw new BoundaryError(
				"refusing to construct the review publisher: the repository policy has no review block",
			);
		}
		requireToken(options.token, "review publisher");
		this.#policy = options.policy;
		this.#send = makeSend(options);
	}

	async postCommitStatus(intent: CommitStatusIntent): Promise<{ statusId: number | null }> {
		this.#requireUrl(intent.url, /^statuses\/[0-9a-f]{40}$/);
		const response = await this.#send("postCommitStatus", intent.method, intent.url, intent.body);
		const id = (await readJson(response))?.id;
		return { statusId: typeof id === "number" ? id : null };
	}

	async postPullRequestReview(
		intent: PullRequestReviewIntent,
	): Promise<{ reviewId: number | null }> {
		this.#requireUrl(intent.url, /^pulls\/\d+\/reviews$/);
		const response = await this.#send(
			"postPullRequestReview",
			intent.method,
			intent.url,
			intent.body,
		);
		const id = (await readJson(response))?.id;
		return { reviewId: typeof id === "number" ? id : null };
	}

	#requireUrl(url: string, tail: RegExp): void {
		const prefix = `/repos/${this.#policy.upstream.owner}/${this.#policy.upstream.repo}/`;
		if (!url.startsWith(prefix) || !tail.test(url.slice(prefix.length))) {
			throw new BoundaryError(
				`refusing review publish: intent targets '${url}', policy binds the ${this.#policy.upstream.owner}/${this.#policy.upstream.repo} upstream`,
			);
		}
	}
}

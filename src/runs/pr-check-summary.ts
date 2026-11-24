/**
 * PR check summary reader (namphuongtran/warren#41).
 *
 * The merge watcher calls this on each poll with the head commit the PR
 * read returned, and stores the result on the run. The same read picks up
 * the `warren/review` commit status the campaign controller publishes on
 * that commit (namphuongtran/warren#38).
 */

import { isFailedCheckRun } from "../ci-fixer/check-runs.ts";
import type { RunPrChecks, RunPrReview, RunPrReviewState } from "../core/wire.ts";
import type { CommitStatus, Forge, RepoRef } from "../forge/contract.ts";
import { isTransient, resolvePollTarget } from "./pr-merge.ts";

/**
 * Read the PR head commit's checks; null when there is nothing to store.
 * `previous` is the summary stored by the last read: a transient status
 * failure keeps its review when it was read for the same commit.
 */
export type PrChecksReader = (
	prUrl: string,
	headCommit: string,
	previous?: RunPrChecks | null,
) => Promise<RunPrChecks | null>;

/** The status context the campaign controller's review policy writes by default. */
export const REVIEW_STATUS_CONTEXT = "warren/review";

export interface CreatePrChecksReaderInput {
	/** Boot-resolved forge (ServerDeps.forge). */
	readonly forge: Forge;
	readonly now?: () => Date;
}

const REVIEW_STATES: Record<CommitStatus["state"], RunPrReviewState> = {
	success: "approved",
	failure: "changes_requested",
	pending: "pending",
	error: "failed",
};

/** What one status read learned about the review on a commit. */
type ReviewRead =
	| { readonly kind: "found"; readonly review: RunPrReview }
	| { readonly kind: "absent" }
	| { readonly kind: "unread" };

async function readReview(forge: Forge, ref: RepoRef, headCommit: string): Promise<ReviewRead> {
	if (!forge.capabilities.commitStatuses) return { kind: "absent" };
	const listed = await forge.listCommitStatuses(ref, headCommit);
	// A credential that cannot read statuses has no review to show; a blip may clear.
	if (!listed.ok) return isTransient(listed.error) ? { kind: "unread" } : { kind: "absent" };
	const status = listed.value.find((s) => s.context === REVIEW_STATUS_CONTEXT);
	if (status === undefined) return { kind: "absent" };
	return {
		kind: "found",
		review: { state: REVIEW_STATES[status.state], description: status.description },
	};
}

function reviewToStore(
	read: ReviewRead,
	headCommit: string,
	previous: RunPrChecks | null | undefined,
): RunPrReview | undefined {
	if (read.kind === "found") return read.review;
	if (read.kind === "absent" || previous?.commit !== headCommit) return undefined;
	return previous.review;
}

export function createPrChecksReader(input: CreatePrChecksReaderInput): PrChecksReader {
	const { forge } = input;
	const now = input.now ?? (() => new Date());
	const readChecks = async (
		ref: RepoRef,
		headCommit: string,
	): Promise<Omit<RunPrChecks, "review"> | null> => {
		const checkedAt = now().toISOString();
		const none = { state: "none", failing: [], commit: headCommit, checkedAt } as const;
		if (!forge.capabilities.checkRuns) return none;
		const listed = await forge.listChecks(ref, headCommit);
		if (!listed.ok) return listed.error.kind === "unsupported" ? none : null;
		const { conclusion, runs } = listed.value;
		if (conclusion === "unknown") return none;
		const failing = runs.filter(isFailedCheckRun).map((run) => run.name);
		return { state: conclusion, failing, commit: headCommit, checkedAt };
	};
	return async (prUrl, headCommit, previous) => {
		const target = resolvePollTarget(forge, prUrl);
		if (target.kind === "unparseable") return null;
		const checks = await readChecks(target.ref, headCommit);
		if (checks === null) return null;
		const review = reviewToStore(
			await readReview(forge, target.ref, headCommit),
			headCommit,
			previous,
		);
		return review === undefined ? checks : { ...checks, review };
	};
}

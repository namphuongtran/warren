/**
 * PR check summary vocabulary (namphuongtran/warren#41), re-exported from
 * wire.ts so the canonical home stays one module.
 *
 * The merge watcher reads the forge's checks for the PR's head commit each
 * time it polls the PR, and stores the summary on the run:
 *
 * - `passing` — every check completed, and none failed.
 * - `failing` — every check completed, and at least one failed.
 * - `pending` — at least one check has not completed yet.
 * - `none` — the commit has no checks, or the forge cannot report them (a
 *   fine-grained GitHub PAT cannot reach the Checks API).
 */
export const RUN_PR_CHECK_STATES = ["passing", "failing", "pending", "none"] as const;
export type RunPrCheckState = (typeof RUN_PR_CHECK_STATES)[number];

/** The check summary stored on the run and served on `GET /runs/:id` and the runs list. */
export interface RunPrChecks {
	readonly state: RunPrCheckState;
	/** Names of the completed checks that failed, in forge order; may be non-empty while pending. */
	readonly failing: readonly string[];
	/** The PR head commit the checks were read for. */
	readonly commit: string;
	/** ISO 8601 instant of the read. */
	readonly checkedAt: string;
	/** The review verdict on the same commit; absent when none was published. */
	readonly review?: RunPrReview;
}

/**
 * The `warren/review` commit status the campaign controller publishes on
 * the PR head (namphuongtran/warren#18), read beside the checks
 * (namphuongtran/warren#38):
 *
 * - `approved` — the reviewer approved this commit.
 * - `changes_requested` — the reviewer asked for changes, or the fix rounds
 *   ran out and the PR needs a human.
 * - `pending` — a review of this commit is in progress.
 * - `failed` — the review itself failed; no verdict exists.
 */
export const RUN_PR_REVIEW_STATES = ["approved", "changes_requested", "pending", "failed"] as const;
export type RunPrReviewState = (typeof RUN_PR_REVIEW_STATES)[number];

export interface RunPrReview {
	readonly state: RunPrReviewState;
	/** The status description, such as "Changes requested (fix round 1 of 2)". */
	readonly description: string | null;
}

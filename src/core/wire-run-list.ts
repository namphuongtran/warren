/**
 * Runs-list filter vocabulary (namphuongtran/warren#39), re-exported from
 * wire.ts so the canonical home stays one module.
 *
 * `GET /runs?pr=` keeps runs by the pull request reap opened for them:
 *
 * - `any` — the run opened a pull request.
 * - `open` — that pull request is not merged or closed, or the merge watcher
 *   has not read it yet.
 * - `merged` — that pull request merged.
 */
export const RUN_LIST_PR_FILTERS = ["any", "open", "merged"] as const;
export type RunListPrFilter = (typeof RUN_LIST_PR_FILTERS)[number];

/** Membership predicate for {@link RUN_LIST_PR_FILTERS}. */
export function isRunListPrFilter(value: unknown): value is RunListPrFilter {
	return typeof value === "string" && (RUN_LIST_PR_FILTERS as readonly string[]).includes(value);
}

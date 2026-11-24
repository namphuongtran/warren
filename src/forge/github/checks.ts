/**
 * GitHub's commit-state reads for `GitHubForge`: check runs (the Checks
 * API) and commit statuses (the legacy Statuses API a controller writes,
 * namphuongtran/warren#38). Pure parsers over the REST JSON.
 */

import type { CheckRun, CheckSummary, CommitStatus } from "../contract.ts";

/** Failure-ish conclusions the CI rollup counts as `failing`. */
const FAILURE_CONCLUSIONS: ReadonlySet<string> = new Set([
	"failure",
	"timed_out",
	"action_required",
	"cancelled",
	"startup_failure",
]);

export function parseCheckRun(raw: unknown): CheckRun | null {
	if (typeof raw !== "object" || raw === null) return null;
	const obj = raw as Record<string, unknown>;
	if (typeof obj.id !== "number") return null;
	const detailsUrl = typeof obj.details_url === "string" ? obj.details_url : null;
	return {
		name: typeof obj.name === "string" ? obj.name : "",
		status: obj.status === "queued" || obj.status === "completed" ? obj.status : "in_progress",
		conclusion: typeof obj.conclusion === "string" ? obj.conclusion : null,
		jobId: String(extractJobId(detailsUrl, obj.id)),
		detailsUrl,
	};
}

/**
 * GitHub Actions check-runs link to `.../actions/runs/<run>/job/<job_id>`;
 * the trailing job id is what the logs endpoint needs. Falls back to the
 * check-run id for third-party CI (same rule as `src/ci-fixer/check-runs.ts`).
 */
function extractJobId(detailsUrl: string | null, fallbackId: number): number {
	if (detailsUrl !== null) {
		const match = /\/job\/(\d+)/.exec(detailsUrl);
		if (match?.[1] !== undefined) {
			const parsed = Number.parseInt(match[1], 10);
			if (Number.isFinite(parsed)) return parsed;
		}
	}
	return fallbackId;
}

/** Roll a commit's check runs up to the domain's decision input. */
export function rollUp(runs: CheckRun[]): CheckSummary["conclusion"] {
	if (runs.length === 0) return "unknown";
	if (runs.some((r) => r.status !== "completed")) return "pending";
	if (runs.some((r) => r.conclusion !== null && FAILURE_CONCLUSIONS.has(r.conclusion))) {
		return "failing";
	}
	return "passing";
}

const STATUS_STATES: ReadonlySet<string> = new Set(["pending", "success", "failure", "error"]);

/**
 * The `statuses` of `GET /commits/{ref}/status`, which already holds only
 * the newest status per context. Entries without a string context or a
 * known state are dropped.
 */
export function parseCommitStatuses(body: unknown): CommitStatus[] {
	const raw = (body as { statuses?: unknown } | null)?.statuses;
	if (!Array.isArray(raw)) return [];
	const statuses: CommitStatus[] = [];
	for (const item of raw) {
		if (typeof item !== "object" || item === null) continue;
		const obj = item as Record<string, unknown>;
		if (typeof obj.context !== "string" || typeof obj.state !== "string") continue;
		if (!STATUS_STATES.has(obj.state)) continue;
		statuses.push({
			context: obj.context,
			state: obj.state as CommitStatus["state"],
			description: typeof obj.description === "string" ? obj.description : null,
		});
	}
	return statuses;
}

/**
 * The needs-attention list (namphuongtran/warren#26): which finished runs
 * wait on the operator, and why. `deriveRunAttention` is pure and holds the
 * rules; `readRunAttention` reads the facts it needs and builds the
 * `GET /attention` body. Nothing is stored, so the run lifecycle gains no state.
 */

import {
	countRunQualityFlags,
	OPS_WINDOW_MS,
	type OpsWindow,
	RUN_ATTENTION_CATEGORIES,
	RUN_ATTENTION_CATEGORY_OF,
	type RunAttentionItem,
	type RunAttentionReason,
	type RunAttentionResponse,
	type RunAttentionRun,
} from "../core/wire.ts";
import type { Repos } from "../db/repos/index.ts";
import { readNeedsInput } from "./needs-input-view.ts";

export interface DeriveRunAttentionInput {
	/** Finished runs, newest first. */
	readonly runs: readonly RunAttentionRun[];
	/** Whether a run's blocked handoff still waits on an answer. */
	readonly needsInput: (runId: string) => boolean;
	/** Runs a retry, or a re-dispatch other than a CI fix, already followed up. */
	readonly redispatched: ReadonlySet<string>;
}

/** The reviewer-facing signals reap recorded on the run. */
function qualityReasons(run: RunAttentionRun): RunAttentionReason[] {
	const reasons: RunAttentionReason[] = [];
	if (run.handoff !== null && run.handoff.state !== "recorded") reasons.push("handoff_missing");
	if (run.qualityGateOutcome === "failed") reasons.push("gate_failed");
	if (run.qualityGateOutcome === "not_run") reasons.push("gate_not_run");
	if (run.qualityFlags !== null && countRunQualityFlags(run.qualityFlags) > 0) {
		reasons.push("shortcut_flags");
	}
	return reasons;
}

/** The PR merged or closed: nothing about the delivered work is left to decide. */
function isPrSettled(run: RunAttentionRun): boolean {
	return run.prState === "merged" || run.prState === "closed_unmerged";
}

/**
 * Each PR's newest run. A fixer run that pushes to the PR records the same
 * URL, and the merge watcher writes the same review onto every run on it, so
 * only the newest one carries the PR's review.
 */
function newestRunPerPr(runs: readonly RunAttentionRun[]): Map<string, string> {
	const newest = new Map<string, string>();
	for (const run of runs) {
		if (run.prUrl !== null && !newest.has(run.prUrl)) newest.set(run.prUrl, run.id);
	}
	return newest;
}

function isChangesRequested(run: RunAttentionRun, newestOnPr: Map<string, string>): boolean {
	return (
		run.prUrl !== null &&
		newestOnPr.get(run.prUrl) === run.id &&
		!isPrSettled(run) &&
		run.prChecks?.review?.state === "changes_requested"
	);
}

function reasonsFor(
	run: RunAttentionRun,
	input: DeriveRunAttentionInput,
	newestOnPr: Map<string, string>,
): RunAttentionReason[] {
	if (run.state === "cancelled") return [];
	const reasons: RunAttentionReason[] = [];
	if (input.needsInput(run.id)) reasons.push("blocked");
	if (isChangesRequested(run, newestOnPr)) reasons.push("changes_requested");
	const followedUp = input.redispatched.has(run.id);
	if (run.state === "failed" && !followedUp) reasons.push("failed");
	if (!followedUp && !isPrSettled(run)) reasons.push(...qualityReasons(run));
	return reasons;
}

/**
 * Derive the list: one item per run that needs the operator, grouped in
 * `RUN_ATTENTION_CATEGORIES` order and newest first within each group.
 */
export function deriveRunAttention(input: DeriveRunAttentionInput): RunAttentionItem[] {
	const newestOnPr = newestRunPerPr(input.runs);
	const items = input.runs.flatMap((run) => {
		const reasons = reasonsFor(run, input, newestOnPr);
		const first = reasons[0];
		return first === undefined
			? []
			: [{ category: RUN_ATTENTION_CATEGORY_OF[first], reasons, run }];
	});
	return RUN_ATTENTION_CATEGORIES.flatMap((category) =>
		items.filter((item) => item.category === category),
	);
}

/** Read the runs queued inside `window` before `now`, and list the ones that need the operator. */
export async function readRunAttention(
	repos: Repos,
	options: { readonly window: OpsWindow; readonly now: Date },
): Promise<RunAttentionResponse> {
	const { window, now } = options;
	const inputs = await repos.runs.readAttentionInputs(now.getTime() - OPS_WINDOW_MS[window]);
	const needsInputFor = await readNeedsInput(repos, inputs.runs);
	const items = deriveRunAttention({
		...inputs,
		needsInput: (runId) => needsInputFor(runId).needsInput,
	});
	return { window, items, generatedAt: now.toISOString() };
}

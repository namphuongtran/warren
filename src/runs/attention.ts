/**
 * The needs-attention list (namphuongtran/warren#26): which finished runs
 * wait on the operator, and why. `deriveRunAttention` is pure and holds the
 * rules; `readRunAttention` reads the facts it needs and builds the
 * `GET /attention` body. The runs list (namphuongtran/warren#39) applies the
 * same rules to one page of rows (`readRunListAttention`) and filters on the
 * page's ids (`readAttentionRunIds`), over the page's widest window. Nothing
 * is stored, so the run lifecycle gains no state.
 */

import {
	countRunQualityFlags,
	OPS_WINDOW_MS,
	type OpsWindow,
	RUN_ATTENTION_CATEGORIES,
	RUN_ATTENTION_CATEGORY_OF,
	RUN_LIST_ATTENTION_WINDOW,
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

/** What the rules read beyond the run row itself. */
interface AttentionContext {
	readonly needsInput: (runId: string) => boolean;
	readonly redispatched: ReadonlySet<string>;
	/** Each PR's newest finished run: only that run carries the PR's review. */
	readonly newestOnPr: ReadonlyMap<string, string>;
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
function newestRunPerPr(
	runs: readonly { readonly id: string; readonly prUrl: string | null }[],
): Map<string, string> {
	const newest = new Map<string, string>();
	for (const run of runs) {
		if (run.prUrl !== null && !newest.has(run.prUrl)) newest.set(run.prUrl, run.id);
	}
	return newest;
}

function isChangesRequested(
	run: RunAttentionRun,
	newestOnPr: ReadonlyMap<string, string>,
): boolean {
	return (
		run.prUrl !== null &&
		newestOnPr.get(run.prUrl) === run.id &&
		!isPrSettled(run) &&
		run.prChecks?.review?.state === "changes_requested"
	);
}

function reasonsFor(run: RunAttentionRun, context: AttentionContext): RunAttentionReason[] {
	if (run.state === "cancelled") return [];
	const reasons: RunAttentionReason[] = [];
	if (context.needsInput(run.id)) reasons.push("blocked");
	if (isChangesRequested(run, context.newestOnPr)) reasons.push("changes_requested");
	const followedUp = context.redispatched.has(run.id);
	if (run.state === "failed" && !followedUp) reasons.push("failed");
	if (!followedUp && !isPrSettled(run)) reasons.push(...qualityReasons(run));
	return reasons;
}

/**
 * Derive the list: one item per run that needs the operator, grouped in
 * `RUN_ATTENTION_CATEGORIES` order and newest first within each group.
 */
export function deriveRunAttention(input: DeriveRunAttentionInput): RunAttentionItem[] {
	const context = { ...input, newestOnPr: newestRunPerPr(input.runs) };
	const items = input.runs.flatMap((run) => {
		const reasons = reasonsFor(run, context);
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

/** A finished run queued inside the window: the runs the Needs attention page reads. */
function isInWindow(run: RunAttentionRun, createdSinceMs: number): boolean {
	return (
		(run.state === "succeeded" || run.state === "failed") &&
		run.createdAt !== null &&
		run.createdAt >= createdSinceMs
	);
}

/**
 * The reasons each row of one runs-list page needs the operator, judged as the
 * Needs attention page judges its widest window: a row the page would list
 * gets the page's reasons, every other row none. The links a row's reasons
 * depend on (its follow-ups, the newest run on its PR) are read for the page's
 * rows, so they hold however the list is filtered or paged.
 */
export async function readRunListAttention(
	repos: Repos,
	runs: readonly RunAttentionRun[],
	options: { readonly needsInput: (runId: string) => boolean; readonly now: Date },
): Promise<(runId: string) => readonly RunAttentionReason[]> {
	const createdSinceMs = options.now.getTime() - OPS_WINDOW_MS[RUN_LIST_ATTENTION_WINDOW];
	const judged = runs.filter((run) => isInWindow(run, createdSinceMs));
	const reasons = new Map<string, readonly RunAttentionReason[]>();
	if (judged.length > 0) {
		const prUrls = judged.flatMap((run) => (run.prUrl === null ? [] : [run.prUrl]));
		const links = await repos.runs.readAttentionLinks({
			runIds: judged.map((run) => run.id),
			prUrls: [...new Set(prUrls)],
			createdSinceMs,
		});
		const context = {
			redispatched: links.redispatched,
			newestOnPr: newestRunPerPr(links.runsOnPrs),
			needsInput: options.needsInput,
		};
		for (const run of judged) reasons.set(run.id, reasonsFor(run, context));
	}
	return (runId) => reasons.get(runId) ?? [];
}

/** The ids of the runs the Needs attention page lists over the runs list's window. */
export async function readAttentionRunIds(repos: Repos, now: Date): Promise<string[]> {
	const body = await readRunAttention(repos, { window: RUN_LIST_ATTENTION_WINDOW, now });
	return body.items.map((item) => item.run.id);
}

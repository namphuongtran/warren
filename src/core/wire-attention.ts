/**
 * Needs-attention vocabulary (namphuongtran/warren#26), re-exported from
 * wire.ts so the canonical home stays one module.
 *
 * `GET /attention` lists the finished runs that wait on the operator. Every
 * item is derived on read from what the run row already stores: the handoff,
 * the failure reason, the gate outcome, the shortcut flags, the PR facts, and
 * the links from the runs that retried or continued it. Nothing is stored, so
 * the run lifecycle gains no state. An item leaves the list when the stored
 * facts change: an answer, a retry, a merge, or the run aging out of the window.
 */

import type { PullRequestLifecycle, RunFailureReason, RunState } from "./wire.ts";
import type { RunHandoffRecord } from "./wire-handoff.ts";
import type { OpsWindow } from "./wire-ops.ts";
import type { RunPrChecks } from "./wire-pr-checks.ts";
import type { RunQualityFlags } from "./wire-quality-flags.ts";
import type { RunQualityGateOutcome } from "./wire-quality-gate.ts";

/**
 * Why a run needs the operator:
 *
 * - `blocked` — the handoff is `blocked` and no operator continuation answered it.
 * - `changes_requested` — the open PR's `warren/review` status asks for
 *   changes, or the fix rounds ran out (namphuongtran/warren#18).
 * - `failed` — the run failed, and nothing retried or re-ran it.
 * - `handoff_missing` — the run left no valid handoff report.
 * - `gate_failed` / `gate_not_run` — the quality gate failed, or the agent
 *   never ran it (namphuongtran/warren#36).
 * - `shortcut_flags` — reap flagged shortcuts in the diff (namphuongtran/warren#37).
 */
export const RUN_ATTENTION_REASONS = [
	"blocked",
	"changes_requested",
	"failed",
	"handoff_missing",
	"gate_failed",
	"gate_not_run",
	"shortcut_flags",
] as const;
export type RunAttentionReason = (typeof RUN_ATTENTION_REASONS)[number];

/** The page's sections, in the order an operator should work them. */
export const RUN_ATTENTION_CATEGORIES = ["blocked", "review", "failed", "quality"] as const;
export type RunAttentionCategory = (typeof RUN_ATTENTION_CATEGORIES)[number];

/** The section each reason belongs to. */
export const RUN_ATTENTION_CATEGORY_OF: Readonly<Record<RunAttentionReason, RunAttentionCategory>> =
	{
		blocked: "blocked",
		changes_requested: "review",
		failed: "failed",
		handoff_missing: "quality",
		gate_failed: "quality",
		gate_not_run: "quality",
		shortcut_flags: "quality",
	};

/** The run facts an item shows, named as on the run row. */
export interface RunAttentionRun {
	readonly id: string;
	readonly agentName: string;
	readonly projectId: string | null;
	readonly state: RunState;
	readonly failureReason: RunFailureReason | null;
	readonly trigger: string;
	readonly prompt: string;
	/** Epoch ms the run was queued. */
	readonly createdAt: number | null;
	readonly endedAt: string | null;
	readonly prUrl: string | null;
	readonly prState: PullRequestLifecycle | null;
	readonly prChecks: RunPrChecks | null;
	readonly qualityGateOutcome: RunQualityGateOutcome | null;
	readonly qualityFlags: RunQualityFlags | null;
	readonly handoff: RunHandoffRecord | null;
}

/**
 * One run that needs the operator. `reasons` lists every reason in
 * `RUN_ATTENTION_REASONS` order; `category` is the first reason's section,
 * so a run appears once, in its most urgent section.
 */
export interface RunAttentionItem {
	readonly category: RunAttentionCategory;
	readonly reasons: readonly RunAttentionReason[];
	readonly run: RunAttentionRun;
}

/**
 * The operator overlay on each `GET /runs` row (namphuongtran/warren#39): the
 * reasons the run needs the operator, in `RUN_ATTENTION_REASONS` order. Empty
 * when the Needs attention page would not list the run over the window below.
 */
export interface RunAttentionView {
	readonly attentionReasons: readonly RunAttentionReason[];
}

/**
 * The window the runs list judges attention over (namphuongtran/warren#39):
 * the page's widest, so every run the page can list is findable from the list.
 */
export const RUN_LIST_ATTENTION_WINDOW = "30d" satisfies OpsWindow;

/** The body of `GET /attention`. Items are grouped by category, newest first within each. */
export interface RunAttentionResponse {
	/** The trailing window of queued runs the list covers. */
	readonly window: OpsWindow;
	readonly items: readonly RunAttentionItem[];
	/** ISO 8601 instant the list was derived. */
	readonly generatedAt: string;
}

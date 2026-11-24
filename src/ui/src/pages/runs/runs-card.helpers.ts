import type { RunRow } from "@/api/types.ts";
import type { InventoryCardTone } from "@/components/ui/inventory-card.tsx";
// Relative, not `@/` — this module is imported by runs-card.helpers.test.ts,
// which runs under the repo-root `bun test`, where the `@/` alias does not
// resolve (see labels.test.ts for the same constraint).
import { isTerminalRunState } from "../../api/types.ts";
import { formatWaitMs } from "../../lib/format-wait.ts";
import { humanizeWireValue } from "../../lib/labels.ts";
import { qualityGateView, type SummaryTone } from "../run-detail/summary-model.ts";

/**
 * Pure cell/subline logic for the Runs mobile row card (warren-f8a2):
 * the mock-conformance decisions — state tone + short word, the
 * one-contextual-extra subline, and the near-cap cost thresholds — live
 * here so they stay testable without pulling React into the test graph.
 *
 * The card anatomy itself is docs/ui-revamp/screens/mobile/runs.jsx
 * (runs.jsx:104-127): line 1 = 70px state cell + id + elapsed/cost,
 * line 2 = agent · project · one contextual extra. The old third meta
 * row (relativeTime · trigger · commits) is gone.
 */

/** Near-cap threshold for the subline's "cap N%" extra (mock: cap 94%). */
export const CAP_SUBLINE_RATIO = 0.8;
/** Warning-tint threshold for the cost note (mock runs.jsx:147). */
export const CAP_WARNING_RATIO = 0.9;

export interface RunGateCell {
	readonly tone: InventoryCardTone;
	readonly label: string;
	/** The Summary tab's one-line explanation of the outcome. */
	readonly title: string;
	/** False for the quiet dash: the project sets no gate, or no outcome is read yet. */
	readonly hasOutcome: boolean;
}

export interface RunStateCell {
	readonly tone: InventoryCardTone;
	readonly label: string;
}

/**
 * The state a runs row shows: the run state, except `stalled` for a running
 * run stuck on a tool call the watchdog warned about (namphuongtran/warren#83),
 * and `deferred` for a queued run held on a spent provider quota
 * (namphuongtran/warren#30).
 */
export function displayStateOf(row: RunRow): RunRow["state"] | "stalled" | "deferred" {
	if (isStalled(row)) return "stalled";
	return isDeferred(row) ? "deferred" : row.state;
}

function isDeferred(row: RunRow): boolean {
	return row.state === "queued" && row.quotaHold !== null && row.quotaHold !== undefined;
}

/**
 * "quota hold, starts in 25m" for a deferred run: the time until Warren
 * launches it (a minute or two after the window resets), then "starting".
 */
export function quotaWaitOf(row: RunRow, now: number): string | null {
	if (!isDeferred(row)) return null;
	const left = Date.parse(row.quotaHold?.releaseAt ?? "") - now;
	if (Number.isNaN(left)) return null;
	return left > 0 ? `quota hold, starts in ${formatWaitMs(left)}` : "quota hold, starting";
}

function isStalled(row: RunRow): boolean {
	return row.state === "running" && row.toolStall !== null && row.toolStall !== undefined;
}

/** "stuck in Bash" for a stalled run, else null. Shared by the card and the table. */
export function stuckInOf(row: RunRow): string | null {
	return isStalled(row) ? `stuck in ${row.toolStall?.toolName ?? "a tool"}` : null;
}

/** State cell (tone + short word), per the mock's state column. */
export function stateCellOf(row: RunRow): RunStateCell {
	switch (row.state) {
		case "running":
			if (isStalled(row)) return { tone: "warning", label: "stalled" };
			return { tone: "info", label: "running" };
		case "queued":
			return { tone: "warning", label: isDeferred(row) ? "deferred" : "queued" };
		case "succeeded":
			// warren-0993: a succeeded run's PR facts pick the short word —
			// "merged" / "PR open" — otherwise the plain state name. The mock
			// paints PR-open with the primary accent; the card vocabulary's
			// closest reachable tone is info.
			if (row.prMergedAt !== null) return { tone: "success", label: "merged" };
			if (row.prState === "open") return { tone: "info", label: "PR open" };
			return { tone: "success", label: "succeeded" };
		case "failed":
			return { tone: "danger", label: "failed" };
		case "cancelled":
			return { tone: "neutral", label: "cancel" };
	}
}

/** "984" from a PR URL's trailing numeric segment; "" when absent. */
function prNumberOf(prUrl: string | null): string {
	if (prUrl === null) return "";
	const segments = prUrl.split("/").filter((s) => s.length > 0);
	const last = segments[segments.length - 1] ?? "";
	return /^\d+$/.test(last) ? last : "";
}

/** Short prose for a failure reason — subline width, tooltip carries raw. */
function shortFailureReason(reason: string): string {
	if (reason === "push_rejected_policy") return "push blocked";
	return humanizeWireValue(reason).toLowerCase();
}

/**
 * Subline: agent · project · ONE contextual extra, per the mock. The extra
 * is picked by state relevance — PR ref for pr-open, commits for delivered,
 * cap % near budget, stop reason for failed. Cancelled rows carry no stop
 * reason on the wire (`failureReason` is null on cancelled), so they stay
 * at two segments.
 */
export function sublineOf(row: RunRow, projectName: string, now: number): string {
	const extras: string[] = [row.agentName, projectName];
	const extra = contextualExtraOf(row, now);
	if (extra !== null) extras.push(extra);
	return extras.join(" · ");
}

function contextualExtraOf(row: RunRow, now: number): string | null {
	if (row.state === "failed" && row.failureReason !== null) {
		return shortFailureReason(row.failureReason);
	}
	if (row.state === "succeeded") {
		const pr = prNumberOf(row.prUrl);
		if (pr !== "") return `PR #${pr}`;
		if (row.commitsAhead !== null && row.commitsAhead > 0) {
			return `${row.commitsAhead} commit${row.commitsAhead === 1 ? "" : "s"}`;
		}
		return null;
	}
	if (row.state === "running" || row.state === "queued") return liveExtraOf(row, now);
	return null;
}

/**
 * A live run's extra: the quota wait of a deferred run, the tool a stalled
 * run is stuck in, else the cap percent near budget.
 */
function liveExtraOf(row: RunRow, now: number): string | null {
	const wait = quotaWaitOf(row, now);
	if (wait !== null) return wait;
	const stuck = stuckInOf(row);
	if (stuck !== null) return stuck;
	const pct = capPctOf(row);
	return pct === null ? null : `cap ${pct}%`;
}

/** Cost-vs-cap percentage, rounded, when a cap is known and spend is near it. */
export function capPctOf(row: RunRow): number | null {
	if (row.maxCostUsd === null || row.maxCostUsd === undefined || row.maxCostUsd <= 0) return null;
	if (row.costUsd === null) return null;
	const ratio = row.costUsd / row.maxCostUsd;
	if (ratio < CAP_SUBLINE_RATIO) return null;
	return Math.round(ratio * 100);
}

/** Warning tint once spend crosses the near-cap threshold. */
export function costNoteToneOf(row: RunRow): "default" | "warning" {
	if (row.maxCostUsd === null || row.maxCostUsd === undefined || row.maxCostUsd <= 0) {
		return "default";
	}
	if (row.costUsd === null) return "default";
	return row.costUsd / row.maxCostUsd >= CAP_WARNING_RATIO ? "warning" : "default";
}

const GATE_TONES: Record<SummaryTone, InventoryCardTone> = {
	success: "success",
	warning: "warning",
	danger: "danger",
	neutral: "muted",
};

/**
 * The runs-list gate cell (namphuongtran/warren#36): the reap-derived outcome
 * as a short toned word. A project without a gate, and a run whose outcome
 * is not read yet, show a quiet dash. The tooltip reuses the Summary copy.
 */
export function gateCellOf(row: RunRow): RunGateCell {
	const outcome = row.qualityGateOutcome;
	const view = qualityGateView(outcome, isTerminalRunState(row.state));
	if (outcome === null || outcome === "unconfigured") {
		return { tone: "muted", label: "—", title: view.detail, hasOutcome: false };
	}
	return {
		tone: GATE_TONES[view.tone],
		label: view.label.toLowerCase(),
		title: view.detail,
		hasOutcome: true,
	};
}

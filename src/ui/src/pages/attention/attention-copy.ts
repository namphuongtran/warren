import { formatRunFailureReason } from "@/lib/labels.ts";
import { plural, type SummaryTone } from "@/pages/run-detail/summary-model.ts";
import {
	countRunQualityFlags,
	type RunAttentionCategory,
	type RunAttentionReason,
	type RunAttentionRun,
} from "../../../../core/wire.ts";

/**
 * Operator copy for the Needs attention page (namphuongtran/warren#26): one
 * heading, explanation, and empty line per section, and one chip per reason.
 */

export interface SectionCopy {
	readonly title: string;
	readonly hint: string;
	readonly empty: string;
}

export const SECTION_COPY: Readonly<Record<RunAttentionCategory, SectionCopy>> = {
	blocked: {
		title: "Blocked on you",
		hint: "The agent stopped with questions. Your answers start a run that continues from its branch.",
		empty: "No run is waiting on an answer.",
	},
	review: {
		title: "Review asked for changes",
		hint: "The review on an open pull request asked for changes, or its fix rounds ran out.",
		empty: "No open pull request has a review asking for changes.",
	},
	failed: {
		title: "Failed",
		hint: "Runs that failed and that nothing has retried or re-run yet.",
		empty: "No failed run is waiting on a retry.",
	},
	quality: {
		title: "Quality signals",
		hint: "Work not yet merged that has no handoff report, a failed or skipped gate, or shortcut flags.",
		empty: "No unmerged work has a quality signal.",
	},
};

/** Each reason's chip: its tone, and its words for this run. */
const REASON_CHIPS: Readonly<
	Record<RunAttentionReason, { tone: SummaryTone; label: (run: RunAttentionRun) => string }>
> = {
	blocked: { tone: "warning", label: () => "Waiting on your answer" },
	changes_requested: { tone: "warning", label: () => "Changes requested" },
	failed: {
		tone: "danger",
		label: (run) =>
			run.failureReason === null
				? "Failed"
				: `Failed: ${formatRunFailureReason(run.failureReason)}`,
	},
	handoff_missing: { tone: "warning", label: () => "No valid handoff" },
	gate_failed: { tone: "danger", label: () => "Gate failed" },
	gate_not_run: { tone: "warning", label: () => "Gate not run" },
	shortcut_flags: {
		tone: "warning",
		label: (run) =>
			plural(
				run.qualityFlags === null ? 0 : countRunQualityFlags(run.qualityFlags),
				"shortcut flag",
			),
	},
};

/** The chip for one reason, worded for this run. */
export function reasonChip(
	reason: RunAttentionReason,
	run: RunAttentionRun,
): { readonly tone: SummaryTone; readonly label: string } {
	const chip = REASON_CHIPS[reason];
	return { tone: chip.tone, label: chip.label(run) };
}

/** The task's first line: the prompt's headline. */
export function taskHeadline(prompt: string): string {
	return prompt.split("\n", 1)[0]?.trim() ?? "";
}

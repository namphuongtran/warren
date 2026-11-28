import type { RunRow } from "@/api/types.ts";
import { isTerminalRunState } from "@/api/types.ts";
import type { InventoryCardTone } from "@/components/ui/inventory-card.tsx";
import { reasonChip } from "@/pages/attention/attention-copy.ts";
import { plural, QUALITY_FLAG_LABELS, qualityFlagsView } from "@/pages/run-detail/summary-model.ts";
import {
	JUDGE_ABSENT_COPY,
	type JudgeAssignment,
	type JudgeStoreRow,
	type JudgeVerdictsState,
	newestJudgeRowByRun,
} from "@/pages/telemetry/judge-verdicts.ts";
import { countRunQualityFlags } from "../../../../core/wire.ts";

/**
 * The runs list's review signals (namphuongtran/warren#39), as pure cell
 * models the desktop table and the phone card both render: what the run
 * changed, its shortcut flags, the judge's verdict, and whether it needs the
 * operator. Missing data reads as a quiet placeholder, never an error.
 */

/** The Changes cell: `+ins −del` over `N files`. */
export interface RunChangesCell {
	/** `+46`; null when there is no diff to count. */
	readonly added: string | null;
	/** `−14` (a minus sign, not a hyphen); null with `added`. */
	readonly removed: string | null;
	/** `2 files`, `none` (the column header says what), or the `—` placeholder. */
	readonly files: string;
	/** One line for the phone card; null while unmeasured. */
	readonly summary: string | null;
	readonly title: string;
}

/** What the run changed, from the diff totals reap measured (warren-ab2b). */
export function changesCellOf(row: RunRow): RunChangesCell {
	const files = row.filesChanged;
	if (files === null) {
		const title = isTerminalRunState(row.state)
			? "Warren did not measure this run's changes."
			: "Warren measures the changes when the run finishes.";
		return { added: null, removed: null, files: "—", summary: null, title };
	}
	if (files === 0) {
		const title = "The run finished without changing a file.";
		return { added: null, removed: null, files: "none", summary: "no changes", title };
	}
	const insertions = row.insertions ?? 0;
	const deletions = row.deletions ?? 0;
	const added = `+${insertions}`;
	const removed = `−${deletions}`;
	const fileCount = plural(files, "file");
	return {
		added,
		removed,
		files: fileCount,
		summary: `${added} ${removed} · ${fileCount}`,
		title: `${plural(insertions, "line")} added and ${deletions} removed, across ${fileCount}.`,
	};
}

/** A toned word with its hover explanation: the flags, judge, and attention cells. */
export interface RunSignalCell {
	readonly tone: InventoryCardTone;
	readonly label: string;
	readonly title: string;
}

/**
 * The shortcut-flag count under the gate word (namphuongtran/warren#37), the
 * kinds on hover. Null when reap did not scan the diff: the gate word stands alone.
 */
export function flagsCellOf(row: RunRow): RunSignalCell | null {
	const flags = row.qualityFlags;
	if (flags === null) return null;
	const { detail } = qualityFlagsView(flags, true);
	const total = countRunQualityFlags(flags);
	if (total === 0) return { tone: "muted", label: "no flags", title: detail };
	const kinds = [...new Set(flags.flags.map((flag) => QUALITY_FLAG_LABELS[flag.kind]))];
	if (flags.omitted > 0) kinds.push(`and ${flags.omitted} more`);
	return { tone: "warning", label: plural(total, "flag"), title: `${kinds.join(", ")}. ${detail}` };
}

const CONFIDENCE_RANK: Readonly<Record<JudgeAssignment["confidence"], number>> = {
	high: 3,
	medium: 2,
	low: 1,
};

/** A rubric class in words: `scope_creep` → `scope creep`. */
const classLabel = (assignment: JudgeAssignment) => assignment.class.replaceAll("_", " ");

/**
 * One run's judge row as a cell: its worst class, clean, or not judged. A run
 * with no row may still be judged, past the loaded page, so it reads as a
 * quiet dash rather than claiming "not judged".
 */
function judgeCellOf(row: JudgeStoreRow | undefined): RunSignalCell {
	if (row === undefined) {
		return {
			tone: "muted",
			label: "—",
			title: "No judge verdict for this run among the recent ones.",
		};
	}
	if (row.kind === "unjudged") {
		const why = row.reason === null ? "" : ` (${row.reason.replaceAll("_", " ")})`;
		return { tone: "muted", label: "not judged", title: `The judge skipped this run${why}.` };
	}
	const assignments = row.verdict?.assignments ?? [];
	const failing = assignments.filter((a) => a.class !== "clean");
	if (failing.length === 0) {
		return assignments.length === 0
			? { tone: "muted", label: "not judged", title: "The judge's verdict carries no classes." }
			: { tone: "success", label: "clean", title: "The judge found no failure class." };
	}
	// Most confident first; sort is stable, so ties keep the verdict's order.
	const ranked = [...failing].sort(
		(a, b) => CONFIDENCE_RANK[b.confidence] - CONFIDENCE_RANK[a.confidence],
	);
	const worst = ranked[0] as JudgeAssignment;
	const more = ranked.length > 1 ? ` +${ranked.length - 1}` : "";
	return {
		tone: "warning",
		label: `${classLabel(worst)}${more}`,
		title: ranked.map((a) => `${classLabel(a)} (${a.confidence} confidence)`).join(", "),
	};
}

/** The Judge column's cell per run, or null when the column is hidden. */
export type RunJudgeColumn = ((runId: string) => RunSignalCell) | null;

/**
 * The Judge column over the judge extension's newest verdict page, or null to
 * hide it: the page has not loaded, or the judge is not deployed here. A judge
 * that is deployed but unreadable keeps the column, with the reason on hover.
 */
export function judgeColumnOf(verdicts: JudgeVerdictsState | undefined): RunJudgeColumn {
	if (verdicts === undefined) return null;
	if (!verdicts.available) {
		if (verdicts.reason === "absent") return null;
		const cell: RunSignalCell = {
			tone: "muted",
			label: "—",
			title: JUDGE_ABSENT_COPY[verdicts.reason],
		};
		return () => cell;
	}
	const newest = newestJudgeRowByRun(verdicts.rows);
	return (runId) => judgeCellOf(newest.get(runId));
}

/**
 * The attention marker (namphuongtran/warren#39): set when the Needs attention
 * page would list the run, its reasons worded as the page words them. Danger
 * when one of them is a failure. Null when the run needs nothing, and for a
 * spectator, whose rows carry no reasons.
 */
export function attentionCellOf(row: RunRow): RunSignalCell | null {
	const reasons = row.attentionReasons ?? [];
	if (reasons.length === 0) return null;
	const chips = reasons.map((reason) => reasonChip(reason, row));
	return {
		tone: chips.some((chip) => chip.tone === "danger") ? "danger" : "warning",
		label: "needs you",
		title: `Needs you: ${chips.map((chip) => chip.label).join(", ")}`,
	};
}

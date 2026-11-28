import { AlertTriangle } from "lucide-react";
import type { ReactNode } from "react";
import type { RunRow } from "@/api/types.ts";
import { INVENTORY_TONE_CLASS } from "@/components/ui/inventory-card.tsx";
import { cn } from "@/lib/utils.ts";
import { gateCellOf } from "./runs-card.helpers.ts";
import { attentionCellOf, changesCellOf, flagsCellOf, type RunSignalCell } from "./runs-signals.ts";

/**
 * The runs list's review-signal cells (namphuongtran/warren#39), shared by the
 * desktop table and the phone card. The cell models live in runs-signals.ts.
 */

/** A cell's toned mono word on its 10px line, and the 9px sub-line under it. */
const CELL_WORD = "font-mono text-2xs";
const CELL_SUBLINE = "font-mono text-3xs";

/**
 * The attention glyph (namphuongtran/warren#39): a warning triangle when the
 * run needs the operator, the reasons on hover. It takes the state dot's place
 * in the State cell, so the list gains the signal without a column; a run that
 * needs nothing keeps its dot (`fallback`).
 */
export function AttentionGlyph({ row, fallback }: { row: RunRow; fallback: ReactNode }) {
	const cell = attentionCellOf(row);
	if (cell === null) return fallback;
	return (
		<span
			role="img"
			aria-label={cell.title}
			title={cell.title}
			className={cn("flex shrink-0", INVENTORY_TONE_CLASS[cell.tone].text)}
		>
			<AlertTriangle className="h-3 w-3" aria-hidden />
		</span>
	);
}

/** The phone card's attention badge: the same signal, as a glyph and a word. */
export function AttentionBadge({ cell }: { cell: RunSignalCell }) {
	return (
		<span
			title={cell.title}
			className={cn("flex items-center gap-1", CELL_WORD, INVENTORY_TONE_CLASS[cell.tone].text)}
		>
			<AlertTriangle className="h-3 w-3" aria-hidden />
			<span>
				{cell.label}
				<span className="sr-only">. {cell.title}</span>
			</span>
		</span>
	);
}

/** CHANGES column: `+ins −del` over the file count, or one quiet word. */
export function ChangesCell({ row }: { row: RunRow }) {
	const cell = changesCellOf(row);
	if (cell.added === null) {
		return (
			<span title={cell.title} className={cn(CELL_WORD, "whitespace-nowrap text-(--color-text-3)")}>
				{cell.files}
			</span>
		);
	}
	return (
		<span title={cell.title} className="flex min-w-0 flex-col gap-0.5">
			<span className={cn(CELL_WORD, "whitespace-nowrap")}>
				<span className="text-(--color-success)">{cell.added}</span>{" "}
				<span className="text-(--color-danger)">{cell.removed}</span>
			</span>
			<span className={cn(CELL_SUBLINE, "text-(--color-text-3)")}>{cell.files}</span>
		</span>
	);
}

/**
 * QUALITY column: the gate outcome reap read from the agent's tool calls
 * (namphuongtran/warren#36) over the shortcut-flag count (#37). No gate, or
 * no outcome yet, reads as a quiet dash; an unscanned diff adds no line.
 */
export function QualityCell({ row }: { row: RunRow }) {
	const gate = gateCellOf(row);
	const flags = flagsCellOf(row);
	const tone = INVENTORY_TONE_CLASS[gate.tone];
	return (
		<span className="flex min-w-0 flex-col gap-0.5">
			<span className="flex items-center gap-1.5 whitespace-nowrap" title={gate.title}>
				{gate.hasOutcome ? (
					<span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", tone.dot)} aria-hidden />
				) : null}
				<span className={cn(CELL_WORD, tone.text)}>{gate.label}</span>
			</span>
			{flags !== null ? (
				<span
					title={flags.title}
					className={cn(CELL_SUBLINE, INVENTORY_TONE_CLASS[flags.tone].text)}
				>
					{flags.label}
				</span>
			) : null}
		</span>
	);
}

/** JUDGE column: the worst class, clean, or not judged; every class on hover. */
export function JudgeCell({ cell }: { cell: RunSignalCell }) {
	return (
		<span
			title={cell.title}
			className={cn(CELL_WORD, "block truncate", INVENTORY_TONE_CLASS[cell.tone].text)}
		>
			{cell.label}
		</span>
	);
}

/**
 * The phone card's signal line: what changed, any shortcut flags, and the
 * judge's word when it scored the run. Undefined when there is nothing to
 * show, so a live run's card keeps its two lines.
 */
export function cardSignalsOf(row: RunRow, judge: RunSignalCell | null): ReactNode | undefined {
	const parts: { key: string; node: ReactNode }[] = [];
	const changes = changesCellOf(row).summary;
	if (changes !== null) parts.push({ key: "changes", node: changes });
	const flags = flagsCellOf(row);
	if (flags !== null && flags.tone === "warning") {
		const tone = INVENTORY_TONE_CLASS[flags.tone].text;
		parts.push({
			key: "flags",
			node: (
				<span title={flags.title} className={tone}>
					{flags.label}
				</span>
			),
		});
	}
	if (judge !== null && (judge.tone === "warning" || judge.tone === "success")) {
		const tone = INVENTORY_TONE_CLASS[judge.tone].text;
		parts.push({
			key: "judge",
			node: (
				<span title={judge.title} className={tone}>
					judge {judge.label}
				</span>
			),
		});
	}
	if (parts.length === 0) return undefined;
	return parts.map((part, i) => (
		<span key={part.key}>
			{i > 0 ? " · " : null}
			{part.node}
		</span>
	));
}

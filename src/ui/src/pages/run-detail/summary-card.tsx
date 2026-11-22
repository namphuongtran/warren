import type { ReactNode } from "react";
import { cn } from "@/lib/utils.ts";
import type { SummaryTone } from "./summary-model.ts";

/**
 * Shared building blocks for the run detail Summary tab
 * (namphuongtran/warren#38): the section card, a toned status chip, a
 * sub-heading, and the muted line every section uses for an honest empty
 * state.
 */

export function SummaryCard({
	title,
	trailing,
	children,
}: {
	title: string;
	trailing?: ReactNode;
	children: ReactNode;
}) {
	return (
		<section
			aria-label={title}
			className="flex shrink-0 flex-col overflow-clip rounded-(--radius-md) border border-(--color-border) bg-(--color-surface)"
		>
			<header className="flex h-10 shrink-0 items-center gap-2 border-(--color-border) border-b px-3">
				<h2 className="font-semibold text-(--color-text) text-xs">{title}</h2>
				<span className="flex-1" />
				{trailing}
			</header>
			<div className="flex flex-col gap-3 p-3 text-(--color-text-2) text-xs">{children}</div>
		</section>
	);
}

const TONE_TEXT: Record<SummaryTone, string> = {
	success: "text-(--color-success)",
	warning: "text-(--color-warning)",
	danger: "text-(--color-danger)",
	neutral: "text-(--color-text-3)",
};

const TONE_DOT: Record<SummaryTone, string> = {
	success: "bg-(--color-success)",
	warning: "bg-(--color-warning)",
	danger: "bg-(--color-danger)",
	neutral: "bg-(--color-text-3)",
};

/** A status word with a coloured dot; the colour never carries the meaning alone. */
export function ToneChip({ tone, children }: { tone: SummaryTone; children: ReactNode }) {
	return (
		<span className="inline-flex shrink-0 items-center gap-1.5">
			<span className={cn("h-1.5 w-1.5 rounded-full", TONE_DOT[tone])} aria-hidden />
			<span className={cn("font-mono text-xs", TONE_TEXT[tone])}>{children}</span>
		</span>
	);
}

/** A labelled block inside a section: "Verification", "How to try", … */
export function SummaryBlock({ label, children }: { label: string; children: ReactNode }) {
	return (
		<div className="flex flex-col gap-1">
			<h3 className="font-medium text-(--color-text-3) text-xs">{label}</h3>
			{children}
		</div>
	);
}

/** The muted line a section shows when it has nothing to report. */
export function SummaryEmpty({ children }: { children: ReactNode }) {
	return <p className="text-(--color-text-3) text-xs">{children}</p>;
}

/** Agent-written free text: escaped by React, whitespace kept, long words wrapped. */
export function AgentText({ children }: { children: string }) {
	return (
		<p className="whitespace-pre-wrap break-words text-(--color-text) text-xs leading-relaxed">
			{children}
		</p>
	);
}

/**
 * The empty-state copy for a fact reap writes: "not yet" while the run is
 * live, "never stored" once it has finished.
 */
export function pendingCopy(isTerminal: boolean, what: string): string {
	return isTerminal
		? `No ${what} was stored for this run.`
		: `The run is still going. Warren stores the ${what} when it finishes.`;
}

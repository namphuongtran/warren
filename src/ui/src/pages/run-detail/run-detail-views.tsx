import type { ReactNode } from "react";
import { Link, useSearchParams } from "react-router-dom";
import type { RunEvent, RunRow } from "@/api/types.ts";
import { cn } from "@/lib/utils.ts";
import { EventTail } from "./event-tail.tsx";
import { ChangesSection, DeliverySection } from "./summary-delivery.tsx";
import { readRunDetailView } from "./summary-model.ts";
import { ApproachSection, OutcomeSection } from "./summary-narrative.tsx";
import { QualitySection } from "./summary-quality.tsx";

/**
 * The run detail main column (namphuongtran/warren#38): a Summary tab, the
 * default, that answers what the agent planned, what it did, how good it is,
 * what changed, and where it went; and an Activity tab holding the event
 * stream. The open tab lives in the URL (`?tab=activity`), so a judge
 * evidence link (`?seq=12-18`) opens Activity with those events marked.
 */

function TabLink({
	search,
	current,
	children,
}: {
	search: string;
	current: boolean;
	children: ReactNode;
}) {
	return (
		<Link
			to={{ search }}
			replace
			aria-current={current ? "page" : undefined}
			className={cn(
				"-mb-px inline-flex h-9 items-center border-b-2 px-3 font-medium text-xs",
				current
					? "border-(--color-primary) text-(--color-text)"
					: "border-transparent text-(--color-text-3) hover:text-(--color-text-2)",
			)}
		>
			{children}
		</Link>
	);
}

function SummaryTab({
	run,
	isTerminal,
	gitUrl,
}: {
	run: RunRow;
	isTerminal: boolean;
	gitUrl: string | undefined;
}) {
	return (
		// At xl the summary scrolls inside the height-bound column; tabIndex lets
		// a keyboard user scroll it even when no section holds a link.
		<section
			aria-label="Run summary"
			// biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region must be focusable
			tabIndex={0}
			className="flex min-h-0 flex-1 flex-col gap-3 xl:overflow-y-auto"
		>
			<ApproachSection run={run} isTerminal={isTerminal} />
			<OutcomeSection run={run} isTerminal={isTerminal} />
			<QualitySection run={run} isTerminal={isTerminal} gitUrl={gitUrl} />
			<ChangesSection run={run} isTerminal={isTerminal} gitUrl={gitUrl} />
			<DeliverySection run={run} isTerminal={isTerminal} />
		</section>
	);
}

export function RunDetailViews({
	run,
	isTerminal,
	gitUrl,
	events,
	status,
	error,
}: {
	run: RunRow;
	isTerminal: boolean;
	gitUrl: string | undefined;
	events: RunEvent[];
	status: string;
	error: string | null;
}) {
	const [params] = useSearchParams();
	const view = readRunDetailView(params);
	return (
		<>
			<nav aria-label="Run views" className="flex shrink-0 border-(--color-border) border-b">
				<TabLink search="" current={view.tab === "summary"}>
					Summary
				</TabLink>
				<TabLink search="?tab=activity" current={view.tab === "activity"}>
					Activity
				</TabLink>
			</nav>
			{view.tab === "summary" ? (
				<SummaryTab run={run} isTerminal={isTerminal} gitUrl={gitUrl} />
			) : (
				<EventTail
					runId={run.id}
					events={events}
					status={status}
					error={error}
					terminal={isTerminal}
					highlight={view.seqRange}
				/>
			)}
		</>
	);
}

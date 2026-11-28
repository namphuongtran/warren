import { useQuery } from "@tanstack/react-query";
import { CheckCircle2 } from "lucide-react";
import { useState } from "react";
import { attentionApi } from "@/api/client.ts";
import { Alert } from "@/components/ui/alert.tsx";
import { Button } from "@/components/ui/button.tsx";
import { EmptyState } from "@/components/ui/empty-state.tsx";
import { FilterPill, FilterPillGroup } from "@/components/ui/filter-pill.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import { formatError } from "@/lib/format-error.ts";
import { SummaryCard, SummaryEmpty } from "@/pages/run-detail/summary-card.tsx";
import {
	OPS_WINDOWS,
	type OpsWindow,
	RUN_ATTENTION_CATEGORIES,
	type RunAttentionCategory,
	type RunAttentionResponse,
} from "../../../core/wire.ts";
import { SECTION_COPY } from "./attention/attention-copy.ts";
import { AttentionItem } from "./attention/attention-item.tsx";

/**
 * Needs attention (namphuongtran/warren#26): the operator's work queue.
 * One `GET /attention?window=` read lists the finished runs that wait on
 * the operator, in four sections: blocked runs with questions to answer,
 * open PRs whose review asked for changes, failed runs nothing retried,
 * and quality signals on unmerged work. Every item is derived from stored
 * run facts, so it leaves the list once an answer, a retry, or a merge lands.
 * The route is operator-only, like the API it reads.
 */

const WINDOW_LABELS: Readonly<Record<OpsWindow, string>> = {
	"24h": "24 hours",
	"7d": "7 days",
	"30d": "30 days",
};

function AttentionSection({
	category,
	body,
}: {
	category: RunAttentionCategory;
	body: RunAttentionResponse;
}) {
	const copy = SECTION_COPY[category];
	const items = body.items.filter((item) => item.category === category);
	return (
		<SummaryCard
			title={copy.title}
			trailing={
				<span className="font-mono text-xs text-(--color-text-3)" aria-hidden>
					{items.length}
				</span>
			}
		>
			<p className="text-(--color-text-3)">{copy.hint}</p>
			{items.length === 0 ? (
				<SummaryEmpty>{copy.empty}</SummaryEmpty>
			) : (
				<ul aria-label={`${copy.title}: ${items.length}`} className="flex flex-col gap-3">
					{items.map((item) => (
						<AttentionItem key={item.run.id} item={item} />
					))}
				</ul>
			)}
		</SummaryCard>
	);
}

function AttentionBody({ body }: { body: RunAttentionResponse }) {
	if (body.items.length === 0) {
		return (
			<EmptyState
				icon={CheckCircle2}
				title="Nothing needs you right now"
				description={`No finished run from the last ${WINDOW_LABELS[body.window]} waits on an answer, a retry, a quality check, or a review.`}
			/>
		);
	}
	return (
		<div className="flex flex-col gap-3">
			{RUN_ATTENTION_CATEGORIES.map((category) => (
				<AttentionSection key={category} category={category} body={body} />
			))}
		</div>
	);
}

export function AttentionPage() {
	const [window, setWindow] = useState<OpsWindow>("7d");
	const attention = useQuery({
		queryKey: ["attention", window],
		queryFn: ({ signal }) => attentionApi.list(window, signal),
		// The lifecycle stream invalidates run lists, not this derived read.
		refetchInterval: 30_000,
	});

	return (
		<div className="flex w-full max-w-5xl min-w-0 flex-1 flex-col gap-4 px-3.5 pt-4 pb-12 md:px-6 md:pt-5">
			<header className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
				<div className="flex min-w-0 flex-col gap-1">
					<h1 className="text-xl leading-6 font-semibold tracking-tight text-(--color-text)">
						Needs attention
					</h1>
					<p className="text-xs text-(--color-text-2)">
						Finished runs that wait on you: questions to answer, failures to retry, quality signals
						to check, and reviews that asked for changes.
					</p>
				</div>
				<FilterPillGroup aria-label="Runs queued in the last" className="shrink-0">
					{OPS_WINDOWS.map((w) => (
						<FilterPill key={w} active={w === window} onClick={() => setWindow(w)}>
							{WINDOW_LABELS[w]}
						</FilterPill>
					))}
				</FilterPillGroup>
			</header>

			{attention.isPending ? (
				<div className="flex items-center gap-2 text-xs text-(--color-text-3)">
					<Spinner size="sm" label="Loading the runs that need you" />
					<span aria-hidden>Loading the runs that need you…</span>
				</div>
			) : attention.isError ? (
				<Alert variant="danger" title="The list could not be loaded">
					<div className="flex flex-col items-start gap-2">
						<span>{formatError(attention.error)}</span>
						<Button size="sm" variant="outline" onClick={() => void attention.refetch()}>
							Try again
						</Button>
					</div>
				</Alert>
			) : (
				<AttentionBody body={attention.data} />
			)}
		</div>
	);
}

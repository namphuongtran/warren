import { Link } from "react-router-dom";
import { relativeTime } from "@/lib/utils.ts";
import { AgentText, ExternalLink, ToneChip } from "@/pages/run-detail/summary-card.tsx";
import type { RunAttentionItem, RunAttentionRun } from "../../../../core/wire.ts";
import { reasonChip, taskHeadline } from "./attention-copy.ts";
import { BlockedAnswer } from "./blocked-answer.tsx";

/**
 * One run on the Needs attention page (namphuongtran/warren#26): the run,
 * its task, every reason it is listed, and what the operator can act on in
 * place. A blocked run carries its questions and the inline answer; a review
 * carries the reviewer's status line and the PR link.
 */

function BlockedDetail({ run }: { run: RunAttentionRun }) {
	const handoff = run.handoff?.state === "recorded" ? run.handoff.handoff : null;
	if (handoff === null) return null;
	return (
		<div className="flex flex-col gap-2">
			<AgentText>{handoff.summary}</AgentText>
			<BlockedAnswer run={run} handoff={handoff} />
		</div>
	);
}

function ReviewDetail({ run }: { run: RunAttentionRun }) {
	const description = run.prChecks?.review?.description ?? null;
	return (
		<div className="flex flex-col gap-1">
			{description !== null ? <p className="break-words">{description}</p> : null}
			{run.prUrl !== null ? <ExternalLink href={run.prUrl}>Open the PR</ExternalLink> : null}
		</div>
	);
}

export function AttentionItem({ item }: { item: RunAttentionItem }) {
	const { run } = item;
	return (
		<li className="flex flex-col gap-2 border-t border-(--color-border) pt-3 first:border-t-0 first:pt-0">
			<div className="flex flex-wrap items-center gap-x-2 gap-y-1">
				<Link
					to={`/runs/${run.id}`}
					className="font-mono text-xs break-all text-(--color-primary) underline-offset-2 hover:underline"
				>
					{run.id}
				</Link>
				<span className="font-mono text-xs text-(--color-text-3)">{run.agentName}</span>
				{run.endedAt !== null ? (
					<span data-visual-mask className="text-xs text-(--color-text-3)">
						ended {relativeTime(run.endedAt)}
					</span>
				) : null}
			</div>
			<p className="line-clamp-2 text-xs break-words text-(--color-text)">
				{taskHeadline(run.prompt)}
			</p>
			<ul aria-label="Reasons" className="flex flex-wrap gap-x-3 gap-y-1">
				{item.reasons.map((reason) => {
					const chip = reasonChip(reason, run);
					return (
						<li key={reason}>
							<ToneChip tone={chip.tone}>{chip.label}</ToneChip>
						</li>
					);
				})}
			</ul>
			{item.category === "blocked" ? <BlockedDetail run={run} /> : null}
			{item.category === "review" ? <ReviewDetail run={run} /> : null}
		</li>
	);
}

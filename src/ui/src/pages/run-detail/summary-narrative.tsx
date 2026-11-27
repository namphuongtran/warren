import type { RunHandoff, RunRow } from "@/api/types.ts";
import { OperatorOnly } from "@/components/operator-only.tsx";
import { cn } from "@/lib/utils.ts";
import { BlockedQuestions } from "./summary-blocked-questions.tsx";
import {
	AgentText,
	pendingCopy,
	SummaryBlock,
	SummaryCard,
	SummaryEmpty,
	ToneChip,
} from "./summary-card.tsx";
import { handoffStatusView } from "./summary-model.ts";

/**
 * The Summary tab's narrative sections (namphuongtran/warren#38): what the
 * agent planned (the approach note, #33) and what it says it did (the
 * handoff report, #21). Both are agent output, so every string renders as
 * escaped text, never as HTML or Markdown.
 */

function ApproachAdherence({ handoff }: { handoff: RunHandoff | null }) {
	const adherence = handoff?.approach;
	if (adherence === undefined) return null;
	if (adherence.followed) {
		return <ToneChip tone="success">The work followed this plan</ToneChip>;
	}
	return (
		<SummaryBlock label="Deviated from the plan">
			<AgentText>{adherence.deviation ?? "The agent gave no reason."}</AgentText>
		</SummaryBlock>
	);
}

export function ApproachSection({ run, isTerminal }: { run: RunRow; isTerminal: boolean }) {
	const record = run.approach;
	const handoff = run.handoff?.state === "recorded" ? run.handoff.handoff : null;
	return (
		<SummaryCard title="Approach">
			{record === null ? (
				<SummaryEmpty>{pendingCopy(isTerminal, "approach note")}</SummaryEmpty>
			) : record.state === "missing" ? (
				<SummaryEmpty>The agent wrote no approach note before it started editing.</SummaryEmpty>
			) : (
				<>
					<AgentText>{record.markdown}</AgentText>
					{record.truncated ? (
						<SummaryEmpty>The note was cut at the 16 KiB limit.</SummaryEmpty>
					) : null}
				</>
			)}
			<ApproachAdherence handoff={handoff} />
		</SummaryCard>
	);
}

function VerificationList({ handoff }: { handoff: RunHandoff }) {
	if (handoff.verification.length === 0) {
		return <SummaryEmpty>The agent listed no verification steps.</SummaryEmpty>;
	}
	return (
		<ul className="flex flex-col gap-2">
			{handoff.verification.map((step, i) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: commands can repeat
				<li key={i} className="flex flex-col gap-0.5">
					<code className="font-mono text-xs break-all text-(--color-text)">{step.command}</code>
					<span className="break-words whitespace-pre-wrap">{step.outcome}</span>
				</li>
			))}
		</ul>
	);
}

function TextList({
	items,
	empty,
	ordered,
}: {
	items: readonly string[];
	empty: string;
	ordered?: boolean;
}) {
	if (items.length === 0) return <SummaryEmpty>{empty}</SummaryEmpty>;
	const List = ordered === true ? "ol" : "ul";
	return (
		<List
			className={cn("flex flex-col gap-1 pl-4", ordered === true ? "list-decimal" : "list-disc")}
		>
			{items.map((item, i) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: agent lines can repeat
				<li key={i} className="break-words whitespace-pre-wrap text-(--color-text)">
					{item}
				</li>
			))}
		</List>
	);
}

function ReviewVerdict({ handoff }: { handoff: RunHandoff }) {
	const review = handoff.review;
	if (review === undefined) return null;
	return (
		<SummaryBlock label="Review verdict">
			<ToneChip tone={review.verdict === "approve" ? "success" : "warning"}>
				{review.verdict === "approve" ? "Approve" : "Request changes"}
			</ToneChip>
			<AgentText>{review.summary}</AgentText>
			{review.findings.length > 0 ? (
				<ul className="flex flex-col gap-2">
					{review.findings.map((f, i) => (
						// biome-ignore lint/suspicious/noArrayIndexKey: findings can repeat a title
						<li key={i} className="flex flex-col gap-0.5">
							<span className="font-medium text-(--color-text)">{f.title}</span>
							{f.path !== null ? (
								<code className="font-mono text-xs break-all">
									{f.line !== null ? `${f.path}:${f.line}` : f.path}
								</code>
							) : null}
							<span className="break-words whitespace-pre-wrap">{f.body}</span>
						</li>
					))}
				</ul>
			) : null}
		</SummaryBlock>
	);
}

function HandoffBody({ run, handoff }: { run: RunRow; handoff: RunHandoff }) {
	const blocked = handoff.status === "blocked";
	const questions = (
		<SummaryBlock label={blocked ? "Blocked on" : "Open questions"}>
			<TextList items={handoff.openQuestions} empty="The agent left no open questions." />
		</SummaryBlock>
	);
	return (
		<>
			<AgentText>{handoff.summary}</AgentText>
			{blocked && handoff.openQuestions.length > 0 ? (
				<OperatorOnly fallback={questions}>
					<BlockedQuestions run={run} handoff={handoff} />
				</OperatorOnly>
			) : (
				questions
			)}
			<SummaryBlock label="How it was verified">
				<VerificationList handoff={handoff} />
			</SummaryBlock>
			<SummaryBlock label="How to try it">
				<TextList items={handoff.howToTry} empty="The agent gave no steps to try it." ordered />
			</SummaryBlock>
			<ReviewVerdict handoff={handoff} />
		</>
	);
}

export function OutcomeSection({ run, isTerminal }: { run: RunRow; isTerminal: boolean }) {
	const record = run.handoff;
	const status = record?.state === "recorded" ? handoffStatusView(record.handoff.status) : null;
	return (
		<SummaryCard
			title="Outcome"
			trailing={status !== null ? <ToneChip tone={status.tone}>{status.label}</ToneChip> : null}
		>
			{record === null ? (
				<SummaryEmpty>{pendingCopy(isTerminal, "handoff report")}</SummaryEmpty>
			) : record.state === "recorded" ? (
				<HandoffBody run={run} handoff={record.handoff} />
			) : record.state === "missing" ? (
				<SummaryEmpty>The agent ended without writing a handoff report.</SummaryEmpty>
			) : (
				<>
					<SummaryEmpty>
						The agent's handoff report failed validation, so it is not shown.
					</SummaryEmpty>
					<code className="font-mono text-xs break-all text-(--color-text-3)">{record.reason}</code>
				</>
			)}
		</SummaryCard>
	);
}

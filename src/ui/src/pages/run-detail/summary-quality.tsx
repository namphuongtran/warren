import { Link } from "react-router-dom";
import type { RunRow } from "@/api/types.ts";
import { Spinner } from "@/components/ui/spinner.tsx";
import {
	JUDGE_ABSENT_COPY,
	type JudgeAssignment,
	type JudgeStoreRow,
	useJudgeVerdicts,
} from "@/pages/telemetry/judge-verdicts.ts";
import { SummaryBlock, SummaryCard, SummaryEmpty, ToneChip } from "./summary-card.tsx";
import { ShortcutFlags } from "./summary-flags.tsx";
import { evidenceHref, findRunJudgeRow, qualityGateView } from "./summary-model.ts";

/**
 * The Summary tab's Quality section (namphuongtran/warren#38): the
 * reap-derived quality-gate outcome (#36), the shortcut flags reap scanned
 * off the diff (#37), and the judge extension's verdict for this run. Core
 * never reads the judge; the UI reads it through the operator-gated
 * `/extensions/judge/verdicts.jsonl` proxy with the same query the
 * Telemetry → Judge tab uses, so both share one cached page.
 */

function EvidenceLinks({ runId, assignment }: { runId: string; assignment: JudgeAssignment }) {
	const ranges = assignment.evidence ?? [];
	if (ranges.length === 0) return null;
	return (
		<span className="flex flex-wrap gap-x-2 gap-y-1">
			{ranges.map((range) => (
				<Link
					key={`${range.fromSeq}-${range.toSeq}`}
					to={evidenceHref(runId, range)}
					className="font-mono text-xs text-(--color-primary) underline-offset-2 hover:underline"
				>
					{range.fromSeq === range.toSeq
						? `event ${range.fromSeq}`
						: `events ${range.fromSeq}–${range.toSeq}`}
				</Link>
			))}
		</span>
	);
}

function VerdictClasses({ runId, row }: { runId: string; row: JudgeStoreRow }) {
	const assignments = row.verdict?.assignments ?? [];
	const failing = assignments.filter((a) => a.class !== "clean");
	if (assignments.length > 0 && failing.length === 0) {
		return <ToneChip tone="success">Clean: the judge found no failure class</ToneChip>;
	}
	if (failing.length === 0) {
		return <SummaryEmpty>The judge's verdict for this run carries no classes.</SummaryEmpty>;
	}
	return (
		<ul className="flex flex-col gap-2">
			{failing.map((a) => (
				<li key={a.class} className="flex flex-col gap-1">
					<span className="flex flex-wrap items-center gap-2">
						<ToneChip tone="warning">{a.class.replaceAll("_", " ")}</ToneChip>
						<span className="text-(--color-text-3)">{a.confidence} confidence</span>
					</span>
					{a.note !== undefined ? (
						<span className="break-words whitespace-pre-wrap">{a.note}</span>
					) : null}
					<EvidenceLinks runId={runId} assignment={a} />
				</li>
			))}
		</ul>
	);
}

function JudgeVerdict({ run }: { run: RunRow }) {
	const verdicts = useJudgeVerdicts();
	if (verdicts.isPending) {
		return (
			<span className="flex items-center gap-2 text-(--color-text-3)">
				<Spinner size="sm" label="Loading the judge verdict" />
				Loading the judge verdict…
			</span>
		);
	}
	if (verdicts.isError) return <SummaryEmpty>{JUDGE_ABSENT_COPY.error}</SummaryEmpty>;
	const state = verdicts.data;
	if (!state.available) return <SummaryEmpty>{JUDGE_ABSENT_COPY[state.reason]}</SummaryEmpty>;
	const row = findRunJudgeRow(state.rows, run.id);
	if (row === null) {
		return (
			<SummaryEmpty>
				The judge has not scored this run, or its verdict is older than the newest 500 verdicts
				shown here.
			</SummaryEmpty>
		);
	}
	if (row.kind === "unjudged") {
		return (
			<SummaryEmpty>
				The judge skipped this run
				{row.reason !== null ? ` (${row.reason.replaceAll("_", " ")})` : ""}.
			</SummaryEmpty>
		);
	}
	return <VerdictClasses runId={run.id} row={row} />;
}

export function QualitySection({
	run,
	isTerminal,
	gitUrl,
}: {
	run: RunRow;
	isTerminal: boolean;
	gitUrl: string | undefined;
}) {
	const gate = qualityGateView(run.qualityGateOutcome, isTerminal);
	return (
		<SummaryCard title="Quality">
			<SummaryBlock label="Quality gate">
				<ToneChip tone={gate.tone}>{gate.label}</ToneChip>
				<span>{gate.detail}</span>
			</SummaryBlock>
			<SummaryBlock label="Shortcut flags">
				<ShortcutFlags run={run} isTerminal={isTerminal} gitUrl={gitUrl} />
			</SummaryBlock>
			<SummaryBlock label="Judge verdict">
				<JudgeVerdict run={run} />
			</SummaryBlock>
		</SummaryCard>
	);
}

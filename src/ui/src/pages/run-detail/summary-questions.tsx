import { useId, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import type { RunHandoff, RunHandoffQuestion, RunRow } from "@/api/types.ts";
import { Button } from "@/components/ui/button.tsx";
import { Label } from "@/components/ui/label.tsx";
import { Textarea } from "@/components/ui/textarea.tsx";
import type { DispatchRouteState } from "@/pages/dispatch/dispatch-draft.ts";
import {
	answeredContinuationPrompt,
	canContinueWithAnswers,
	type OperatorReply,
} from "./continuation-prompt.ts";
import { SummaryBlock, SummaryEmpty } from "./summary-card.tsx";

/**
 * A handoff's open questions (namphuongtran/warren#25), each with the
 * options the agent weighed and the answer it recommends. Every string is
 * agent output, so it renders as escaped text.
 */
function QuestionDetails({ question }: { question: RunHandoffQuestion }) {
	if (question.options.length === 0 && question.recommendation === null) return null;
	return (
		<div className="flex flex-col gap-1">
			{question.options.length > 0 ? (
				<ul aria-label="Options" className="flex list-disc flex-col gap-0.5 pl-4">
					{question.options.map((option, i) => (
						// biome-ignore lint/suspicious/noArrayIndexKey: options can repeat
						<li key={i} className="break-words whitespace-pre-wrap">
							{option}
						</li>
					))}
				</ul>
			) : null}
			{question.recommendation !== null ? (
				<p className="break-words whitespace-pre-wrap">
					<span className="font-medium text-(--color-text)">Recommended: </span>
					{question.recommendation}
				</p>
			) : null}
		</div>
	);
}

/** The read-only question list: a spectator's view, and any run that is not blocked. */
export function QuestionList({ questions }: { questions: readonly RunHandoffQuestion[] }) {
	if (questions.length === 0) {
		return <SummaryEmpty>The agent left no open questions.</SummaryEmpty>;
	}
	return (
		<ol className="flex list-decimal flex-col gap-2 pl-4">
			{questions.map((question, i) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: questions can repeat
				<li key={i} className="break-words">
					<p className="whitespace-pre-wrap text-(--color-text)">{question.question}</p>
					<div className="pt-1">
						<QuestionDetails question={question} />
					</div>
				</li>
			))}
		</ol>
	);
}

/** The continuation that already answered this run, when there is one. */
function AnsweredNote({ runId }: { runId: string | null | undefined }) {
	if (typeof runId !== "string") return null;
	return (
		<p className="text-xs text-(--color-text-3)">
			{"Answered in run "}
			<Link
				to={`/runs/${runId}`}
				className="font-mono break-all text-(--color-primary) underline-offset-2 hover:underline"
			>
				{runId}
			</Link>
			. Answer again only if that run did not settle what blocked this one.
		</p>
	);
}

/** The operator's draft reply to a blocked handoff. */
export interface AnswerDraft {
	readonly questions: readonly RunHandoffQuestion[];
	/** One draft answer per question, in order. */
	readonly answers: readonly string[];
	readonly setAnswer: (index: number, value: string) => void;
	/** What the agent should do next, asked only when there is no question. */
	readonly instructions: string;
	readonly setInstructions: (value: string) => void;
	/** What the operator gives the agent, for the form's button and caption. */
	readonly subject: "answers" | "instructions";
	readonly reply: OperatorReply;
}

/** The operator's draft answers to `questions`, one per question, in order. */
export function useAnswers(questions: readonly RunHandoffQuestion[]): AnswerDraft {
	const [answers, setAnswers] = useState<readonly string[]>(() => questions.map(() => ""));
	const [instructions, setInstructions] = useState("");
	const answered = questions.map((question, i) => ({ question, answer: answers[i] ?? "" }));
	function setAnswer(index: number, value: string) {
		setAnswers((prev) => prev.map((a, i) => (i === index ? value : a)));
	}
	const asked = questions.length > 0;
	return {
		questions,
		answers,
		setAnswer,
		instructions,
		setInstructions,
		subject: asked ? "answers" : "instructions",
		reply: asked ? { answers: answered } : { answers: [], instructions },
	};
}

/**
 * The one field a blocked handoff with no question gets (namphuongtran/warren#25):
 * the schema lets an agent stop blocked and say why only in its summary, and
 * the run still waits on the operator.
 */
function NextStepField({ value, onChange }: { value: string; onChange: (value: string) => void }) {
	const fieldId = useId();
	return (
		<div className="flex flex-col gap-1.5">
			<Label htmlFor={fieldId} className="text-xs leading-relaxed font-normal text-(--color-text)">
				What should the agent do next?
			</Label>
			<p id={`${fieldId}-hint`} className="text-xs text-(--color-text-3)">
				The agent stopped without asking a question. Its summary says what blocked it.
			</p>
			<Textarea
				id={fieldId}
				aria-describedby={`${fieldId}-hint`}
				rows={3}
				value={value}
				onChange={(e) => onChange(e.target.value)}
				placeholder="Tell the agent how to go on."
				className="text-xs"
			/>
		</div>
	);
}

/**
 * One answer field per open question, each labelled by its question, with
 * the options the agent weighed and a one-click "Use the recommendation".
 * A handoff with no question gets one field for what to do next. The run
 * Summary and the Needs attention page (namphuongtran/warren#26) both
 * answer through it.
 */
export function AnswerFields({ draft }: { draft: AnswerDraft }) {
	const idBase = useId();
	const { questions, answers, setAnswer } = draft;
	if (questions.length === 0) {
		return <NextStepField value={draft.instructions} onChange={draft.setInstructions} />;
	}
	return (
		<ol className="flex flex-col gap-3">
			{questions.map((question, i) => {
				const fieldId = `${idBase}-answer-${i}`;
				const recommendation = question.recommendation;
				return (
					// biome-ignore lint/suspicious/noArrayIndexKey: questions can repeat
					<li key={i} className="flex flex-col gap-1.5">
						<Label
							htmlFor={fieldId}
							className="text-xs leading-relaxed font-normal break-words whitespace-pre-wrap text-(--color-text)"
						>
							{`${i + 1}. ${question.question}`}
						</Label>
						<QuestionDetails question={question} />
						<Textarea
							id={fieldId}
							rows={2}
							value={answers[i] ?? ""}
							onChange={(e) => setAnswer(i, e.target.value)}
							placeholder={
								recommendation === null
									? "Your answer. Leave it blank to let the agent decide."
									: "Your answer. Leave it blank to take the recommendation."
							}
							className="text-xs"
						/>
						{recommendation !== null ? (
							<Button
								size="sm"
								variant="outline"
								className="w-fit"
								aria-label={`Use the recommendation for question ${i + 1}`}
								onClick={() => setAnswer(i, recommendation)}
							>
								Use the recommendation
							</Button>
						) : null}
					</li>
				);
			})}
		</ol>
	);
}

/**
 * Answer controls for a blocked run (namphuongtran/warren#38, #25). The
 * operator answers each open question here, or takes the agent's
 * recommendation; "Continue with answers" opens Dispatch as a continuation
 * of this run (`continueFromRunId`) with the answers written into the
 * prompt. The Dispatch page is the confirm step, so nothing launches from
 * this card. The caller gates it behind the dispatch capability, like every
 * other dispatch affordance on run detail.
 */
export function BlockedQuestions({ run, handoff }: { run: RunRow; handoff: RunHandoff }) {
	const navigate = useNavigate();
	const draft = useAnswers(handoff.openQuestions);

	function continueWithAnswers() {
		const prompt = answeredContinuationPrompt({
			task: run.prompt,
			handoffSummary: handoff.summary,
			...draft.reply,
		});
		navigate("/dispatch", {
			state: {
				continueFromRunId: run.id,
				agent: run.agentName,
				project: run.projectId ?? undefined,
				prompt,
			} satisfies DispatchRouteState,
		});
	}

	return (
		<SummaryBlock label="Blocked on">
			<AnsweredNote runId={run.answeredByRunId} />
			<AnswerFields draft={draft} />
			<div className="flex flex-wrap items-center gap-2 pt-1">
				<Button
					size="sm"
					onClick={continueWithAnswers}
					disabled={!canContinueWithAnswers(draft.reply)}
				>
					{`Continue with ${draft.subject}`}
				</Button>
				<span className="text-xs text-(--color-text-3)">
					{`Opens Dispatch with the ${draft.subject} in a follow-up prompt. Nothing runs until you dispatch.`}
				</span>
			</div>
		</SummaryBlock>
	);
}

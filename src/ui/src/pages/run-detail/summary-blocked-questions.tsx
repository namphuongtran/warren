import { useId, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { RunHandoff, RunRow } from "@/api/types.ts";
import { Button } from "@/components/ui/button.tsx";
import { Label } from "@/components/ui/label.tsx";
import { Textarea } from "@/components/ui/textarea.tsx";
import type { DispatchRouteState } from "@/pages/dispatch/dispatch-draft.ts";
import { SummaryBlock } from "./summary-card.tsx";
import { answeredContinuationPrompt } from "./summary-model.ts";

/**
 * Answer controls for a blocked run (namphuongtran/warren#38, #25). The
 * operator answers each open question here; "Continue with answers" opens
 * Dispatch as a continuation of this run (`continueFromRunId`) with the
 * answers written into the prompt. The Dispatch page is the confirm step,
 * so nothing launches from this card. The caller gates it behind the
 * dispatch capability, like every other dispatch affordance on run detail.
 */
export function BlockedQuestions({ run, handoff }: { run: RunRow; handoff: RunHandoff }) {
	const questions = handoff.openQuestions;
	const navigate = useNavigate();
	const idBase = useId();
	const [answers, setAnswers] = useState<readonly string[]>(() => questions.map(() => ""));
	const answeredCount = answers.filter((a) => a.trim() !== "").length;

	function setAnswer(index: number, value: string) {
		setAnswers((prev) => prev.map((a, i) => (i === index ? value : a)));
	}

	function continueWithAnswers() {
		const prompt = answeredContinuationPrompt({
			task: run.prompt,
			handoffSummary: handoff.summary,
			answers: questions.map((question, i) => ({ question, answer: answers[i] ?? "" })),
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
			<ol className="flex flex-col gap-3">
				{questions.map((question, i) => {
					const fieldId = `${idBase}-answer-${i}`;
					return (
						// biome-ignore lint/suspicious/noArrayIndexKey: questions can repeat
						<li key={i} className="flex flex-col gap-1.5">
							<Label
								htmlFor={fieldId}
								className="whitespace-pre-wrap break-words font-normal text-(--color-text) text-xs leading-relaxed"
							>
								{`${i + 1}. ${question}`}
							</Label>
							<Textarea
								id={fieldId}
								rows={2}
								value={answers[i] ?? ""}
								onChange={(e) => setAnswer(i, e.target.value)}
								placeholder="Your answer. Leave it blank to let the agent decide."
								className="text-xs"
							/>
						</li>
					);
				})}
			</ol>
			<div className="flex flex-wrap items-center gap-2 pt-1">
				<Button size="sm" onClick={continueWithAnswers} disabled={answeredCount === 0}>
					Continue with answers
				</Button>
				<span className="text-(--color-text-3) text-xs">
					Opens Dispatch with the answers in a follow-up prompt. Nothing runs until you dispatch.
				</span>
			</div>
		</SummaryBlock>
	);
}

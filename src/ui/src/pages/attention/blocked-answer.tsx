import { useMutation, useQueryClient } from "@tanstack/react-query";
import { runsApi } from "@/api/client.ts";
import { OperatorOnly } from "@/components/operator-only.tsx";
import { Alert } from "@/components/ui/alert.tsx";
import { Button } from "@/components/ui/button.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import { formatError } from "@/lib/format-error.ts";
import {
	answeredContinuationPrompt,
	canContinueWithAnswers,
} from "@/pages/run-detail/continuation-prompt.ts";
import { AnswerFields, QuestionList, useAnswers } from "@/pages/run-detail/summary-questions.tsx";
import type { RunAttentionRun, RunHandoff } from "../../../../core/wire.ts";

/**
 * The inline answer to a blocked run (namphuongtran/warren#26): the operator
 * answers each open question, and "Dispatch continuation" posts the
 * continuation straight away (`POST /runs` with `continueFromRunId`). It
 * writes the same follow-up prompt as the run Summary's Dispatch flow. The
 * form sits behind the dispatch capability, so a caller without it, and a
 * run without a project (which cannot be continued), see the questions
 * read-only.
 */
export function BlockedAnswer({ run, handoff }: { run: RunAttentionRun; handoff: RunHandoff }) {
	const readOnly = <QuestionList questions={handoff.openQuestions} />;
	const project = run.projectId;
	if (project === null) return readOnly;
	return (
		<OperatorOnly fallback={readOnly}>
			<AnswerForm run={run} handoff={handoff} project={project} />
		</OperatorOnly>
	);
}

function AnswerForm({
	run,
	handoff,
	project,
}: {
	run: RunAttentionRun;
	handoff: RunHandoff;
	project: string;
}) {
	const draft = useAnswers(handoff.openQuestions);
	const queryClient = useQueryClient();
	const { toast } = useToast();
	const dispatch = useMutation({
		mutationFn: () =>
			runsApi.create({
				agent: run.agentName,
				project,
				prompt: answeredContinuationPrompt({
					task: run.prompt,
					handoffSummary: handoff.summary,
					...draft.reply,
				}),
				continueFromRunId: run.id,
			}),
		onSuccess: ({ run: continuation }) => {
			toast({
				variant: "success",
				title: "Continuation dispatched",
				// The toast renders outside the router, so a plain hash link, not <Link>.
				description: (
					<a href={`#/runs/${continuation.id}`} className="font-mono underline underline-offset-2">
						Open run {continuation.id}
					</a>
				),
			});
			void queryClient.invalidateQueries({ queryKey: ["attention"] });
			void queryClient.invalidateQueries({ queryKey: ["runs"] });
		},
	});

	return (
		<div className="flex flex-col gap-3">
			<AnswerFields draft={draft} />
			{dispatch.isError ? <Alert variant="danger">{formatError(dispatch.error)}</Alert> : null}
			<div className="flex flex-wrap items-center gap-2">
				<Button
					size="sm"
					onClick={() => dispatch.mutate()}
					// Stays disabled after success: one answer dispatches one continuation.
					// An error re-enables it, so the operator can try again.
					disabled={
						!canContinueWithAnswers(draft.reply) || dispatch.isPending || dispatch.isSuccess
					}
				>
					{dispatch.isPending
						? "Dispatching…"
						: dispatch.isSuccess
							? "Continuation dispatched"
							: "Dispatch continuation"}
				</Button>
				<span className="text-xs text-(--color-text-3)">
					{`Starts a run that continues from this one's branch, with your ${draft.subject} in its prompt.`}
				</span>
			</div>
		</div>
	);
}

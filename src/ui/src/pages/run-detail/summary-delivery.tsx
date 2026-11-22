import type { RunRow } from "@/api/types.ts";
import { formatPullRequestLifecycle } from "@/lib/labels.ts";
import { formatTimestamp } from "@/lib/utils.ts";
import { pendingCopy, SummaryBlock, SummaryCard, SummaryEmpty, ToneChip } from "./summary-card.tsx";
import { changesLink, pullRequestTone, pushedBranch } from "./summary-model.ts";

/**
 * The Summary tab's Changes and Delivery sections (namphuongtran/warren#38):
 * the reap-measured diff size with a link to the forge view of the diff, and
 * where the work went: the pushed branch and the pull request.
 */

function plural(n: number, word: string): string {
	return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function ExternalLink({ href, children }: { href: string; children: string }) {
	return (
		<a
			href={href}
			target="_blank"
			rel="noreferrer noopener"
			className="w-fit font-medium text-(--color-primary) text-xs underline-offset-2 hover:underline"
		>
			{children} ↗
		</a>
	);
}

export function ChangesSection({
	run,
	isTerminal,
	gitUrl,
}: {
	run: RunRow;
	isTerminal: boolean;
	gitUrl: string | undefined;
}) {
	const link = changesLink(run, gitUrl);
	const files = run.filesChanged;
	return (
		<SummaryCard title="Changes">
			{files === null ? (
				<SummaryEmpty>{pendingCopy(isTerminal, "diff measurement")}</SummaryEmpty>
			) : files === 0 ? (
				<SummaryEmpty>The run changed no files.</SummaryEmpty>
			) : (
				<p className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-(--color-text) text-xs">
					<span>{plural(files, "file")} changed</span>
					{run.insertions !== null ? (
						<span className="text-(--color-success)">+{run.insertions}</span>
					) : null}
					{run.deletions !== null ? (
						<span className="text-(--color-danger)">−{run.deletions}</span>
					) : null}
					{run.commitsAhead !== null ? (
						<span className="text-(--color-text-3)">{plural(run.commitsAhead, "commit")}</span>
					) : null}
				</p>
			)}
			{link !== null ? <ExternalLink href={link.href}>{link.label}</ExternalLink> : null}
		</SummaryCard>
	);
}

function PullRequest({ run, isTerminal }: { run: RunRow; isTerminal: boolean }) {
	if (run.prUrl === null && run.prState === null) {
		return (
			<SummaryEmpty>
				{isTerminal
					? "No pull request was opened for this run."
					: "If the project opens pull requests, one appears here when the run finishes."}
			</SummaryEmpty>
		);
	}
	return (
		<div className="flex flex-wrap items-center gap-x-3 gap-y-1">
			<ToneChip tone={pullRequestTone(run.prState)}>
				{run.prState === null ? "State not checked yet" : formatPullRequestLifecycle(run.prState)}
			</ToneChip>
			{run.prMergedAt !== null ? (
				<span className="text-(--color-text-3)">merged {formatTimestamp(run.prMergedAt)}</span>
			) : null}
			{run.prUrl !== null ? <ExternalLink href={run.prUrl}>Open the PR</ExternalLink> : null}
		</div>
	);
}

export function DeliverySection({ run, isTerminal }: { run: RunRow; isTerminal: boolean }) {
	const branch = pushedBranch(run);
	return (
		<SummaryCard title="Delivery">
			<SummaryBlock label="Branch">
				{branch !== null ? (
					<code className="break-all font-mono text-(--color-text) text-xs">{branch}</code>
				) : (
					<SummaryEmpty>No branch was recorded for this run.</SummaryEmpty>
				)}
			</SummaryBlock>
			<SummaryBlock label="Pull request">
				<PullRequest run={run} isTerminal={isTerminal} />
			</SummaryBlock>
		</SummaryCard>
	);
}

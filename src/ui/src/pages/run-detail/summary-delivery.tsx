import type { RunRow } from "@/api/types.ts";
import { formatPullRequestLifecycle } from "@/lib/labels.ts";
import { formatTimestamp } from "@/lib/utils.ts";
import {
	ExternalLink,
	pendingCopy,
	SummaryBlock,
	SummaryCard,
	SummaryEmpty,
	ToneChip,
} from "./summary-card.tsx";
import {
	changesLink,
	plural,
	prChecksView,
	prReviewView,
	pullRequestTone,
	pushedBranch,
} from "./summary-model.ts";

/**
 * The Summary tab's Changes and Delivery sections (namphuongtran/warren#38):
 * the reap-measured diff size with a link to the forge view of the diff, and
 * where the work went: the pushed branch, the pull request, its checks
 * (namphuongtran/warren#41), and the review verdict on its head commit.
 */

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
				<p className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-xs text-(--color-text)">
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

/** The PR head commit's checks, as the merge watcher last read them. */
function PullRequestChecks({ run }: { run: RunRow }) {
	const view = prChecksView(run.prChecks);
	const checks = run.prChecks;
	return (
		<div className="flex flex-col gap-1">
			<div className="flex flex-wrap items-center gap-x-3 gap-y-1">
				<ToneChip tone={view.tone}>{view.label}</ToneChip>
				{checks !== null ? (
					<span className="text-(--color-text-3)">
						<code className="font-mono">{checks.commit.slice(0, 7)}</code>, read{" "}
						{formatTimestamp(checks.checkedAt)}
					</span>
				) : null}
			</div>
			<p className="text-xs text-(--color-text-3)">{view.detail}</p>
			{checks !== null && checks.failing.length > 0 ? (
				<ul aria-label="Failed checks" className="flex flex-col gap-0.5">
					{checks.failing.map((name) => (
						<li key={name} className="font-mono text-xs break-words text-(--color-danger)">
							{name}
						</li>
					))}
				</ul>
			) : null}
		</div>
	);
}

/** The review verdict on the PR head commit, read with the checks. */
function PullRequestReview({ run }: { run: RunRow }) {
	const view = prReviewView(run.prChecks);
	return (
		<div className="flex flex-col gap-1">
			<ToneChip tone={view.tone}>{view.label}</ToneChip>
			<p className="text-xs break-words text-(--color-text-3)">{view.detail}</p>
		</div>
	);
}

export function DeliverySection({ run, isTerminal }: { run: RunRow; isTerminal: boolean }) {
	const branch = pushedBranch(run);
	return (
		<SummaryCard title="Delivery">
			<SummaryBlock label="Branch">
				{branch !== null ? (
					<code className="font-mono text-xs break-all text-(--color-text)">{branch}</code>
				) : (
					<SummaryEmpty>No branch was recorded for this run.</SummaryEmpty>
				)}
			</SummaryBlock>
			<SummaryBlock label="Pull request">
				<PullRequest run={run} isTerminal={isTerminal} />
			</SummaryBlock>
			{run.prUrl !== null ? (
				<>
					<SummaryBlock label="Checks">
						<PullRequestChecks run={run} />
					</SummaryBlock>
					<SummaryBlock label="Review">
						<PullRequestReview run={run} />
					</SummaryBlock>
				</>
			) : null}
		</SummaryCard>
	);
}

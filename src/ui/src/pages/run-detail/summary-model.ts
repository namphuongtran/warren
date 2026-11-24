/**
 * Pure view-model helpers for the run detail Summary and Activity tabs
 * (namphuongtran/warren#38). No React, no `@/` alias: the repo-root
 * `bun test` loads this module directly.
 */

import type {
	PullRequestLifecycle,
	RunHandoffStatus,
	RunPrChecks,
	RunQualityGateOutcome,
	RunRow,
} from "../../api/types.ts";
import type { JudgeEvidenceRange, JudgeStoreRow } from "../telemetry/judge-verdicts.ts";

/** The two run detail tabs. Summary is the default view. */
export const RUN_DETAIL_TABS = ["summary", "activity"] as const;
export type RunDetailTab = (typeof RUN_DETAIL_TABS)[number];

/** An inclusive range of run event sequence numbers: the judge's evidence shape. */
export type SeqRange = JudgeEvidenceRange;

export interface RunDetailView {
	readonly tab: RunDetailTab;
	readonly seqRange: SeqRange | null;
}

function isRunDetailTab(value: string | null): value is RunDetailTab {
	return value !== null && (RUN_DETAIL_TABS as readonly string[]).includes(value);
}

const SEQ_PARAM = /^(\d+)(?:-(\d+))?$/;

/** `12-18` or `7` → a range; anything else, or a backwards range, → null. */
function parseSeqRange(raw: string | null): SeqRange | null {
	const match = raw === null ? null : SEQ_PARAM.exec(raw);
	if (match === null || match[1] === undefined) return null;
	const fromSeq = Number(match[1]);
	const toSeq = match[2] === undefined ? fromSeq : Number(match[2]);
	return toSeq < fromSeq ? null : { fromSeq, toSeq };
}

/**
 * Read the open tab and the highlighted event range from the run detail
 * URL's search params. An evidence range only makes sense on Activity, so
 * it opens that tab.
 */
export function readRunDetailView(params: URLSearchParams): RunDetailView {
	const tab = params.get("tab");
	const seqRange = parseSeqRange(params.get("seq"));
	if (seqRange !== null) return { tab: "activity", seqRange };
	return { tab: isRunDetailTab(tab) ? tab : "summary", seqRange: null };
}

/** The run detail URL that opens Activity with `range` highlighted. */
export function evidenceHref(runId: string, range: SeqRange): string {
	const seq =
		range.fromSeq === range.toSeq ? String(range.fromSeq) : `${range.fromSeq}-${range.toSeq}`;
	return `/runs/${encodeURIComponent(runId)}?tab=activity&seq=${seq}`;
}

/**
 * This run's judge row from the verdict export page, or null when the judge
 * has not scored it. A run judged twice resolves to the newest row (the
 * highest id), whatever order the page arrived in.
 */
export function findRunJudgeRow(
	rows: readonly JudgeStoreRow[],
	runId: string,
): JudgeStoreRow | null {
	let newest: JudgeStoreRow | null = null;
	for (const row of rows) {
		if (row.runId === runId && (newest === null || row.id > newest.id)) newest = row;
	}
	return newest;
}

/** Where the operator reads the run's diff on the forge. */
export interface ChangesLink {
	readonly href: string;
	readonly label: string;
}

const GITHUB_PR_URL = /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+$/;
const GITHUB_REMOTE =
	/^(?:https:\/\/github\.com\/|git@github\.com:)([^/]+)\/([^/]+?)(?:\.git)?\/?$/;

/**
 * The forge view of the run's diff: the PR's files view when reap opened a
 * PR, otherwise a GitHub compare view from the measured base commit to the
 * branch reap pushed. Null when the run has neither, or the remote is not
 * on GitHub (no other forge's compare URL is known here).
 */
export function changesLink(
	run: Pick<RunRow, "prUrl" | "baseSha" | "branch" | "targetBranch">,
	gitUrl: string | null | undefined,
): ChangesLink | null {
	if (run.prUrl !== null) {
		return GITHUB_PR_URL.test(run.prUrl)
			? { href: `${run.prUrl}/files`, label: "Files on the PR" }
			: { href: run.prUrl, label: "Open the PR" };
	}
	const pushed = pushedBranch(run);
	const remote = gitUrl === null || gitUrl === undefined ? null : GITHUB_REMOTE.exec(gitUrl);
	if (remote === null || run.baseSha === null || pushed === null) return null;
	const [, owner, repo] = remote;
	return {
		href: `https://github.com/${owner}/${repo}/compare/${run.baseSha}...${pushed}`,
		label: "Compare on GitHub",
	};
}

/** The branch reap pushed: the existing target branch when set, else the run's own. */
export function pushedBranch(run: Pick<RunRow, "targetBranch" | "branch">): string | null {
	return run.targetBranch ?? run.branch;
}

/** Status colour family a Summary fact renders in. */
export type SummaryTone = "success" | "warning" | "danger" | "neutral";

export interface SummaryFactView {
	readonly label: string;
	readonly tone: SummaryTone;
	readonly detail: string;
}

const GATE_VIEWS: Record<RunQualityGateOutcome, SummaryFactView> = {
	passed: {
		label: "Passed",
		tone: "success",
		detail: "The last gate run exited zero and no file changed after it.",
	},
	failed: { label: "Failed", tone: "danger", detail: "The last gate run exited non-zero." },
	stale: {
		label: "Stale",
		tone: "warning",
		detail: "The gate passed, then the agent edited files without running it again.",
	},
	not_run: {
		label: "Not run",
		tone: "warning",
		detail: "The project sets a gate, and the agent never ran it.",
	},
	unknown: {
		label: "Unknown",
		tone: "warning",
		detail: "The agent ran the gate, but its exit status could not be read.",
	},
	unconfigured: {
		label: "No gate",
		tone: "neutral",
		detail: "The project sets no quality gate.",
	},
};

/**
 * The quality-gate fact. A null outcome means "not yet" on a live run and
 * "never recorded" on a finished one (a row older than the column).
 */
export function qualityGateView(
	outcome: RunQualityGateOutcome | null,
	isTerminal: boolean,
): SummaryFactView {
	if (outcome !== null) return GATE_VIEWS[outcome];
	return isTerminal
		? { label: "Not recorded", tone: "neutral", detail: "No gate outcome was stored for this run." }
		: {
				label: "Pending",
				tone: "neutral",
				detail: "Warren reads the gate outcome when the run finishes.",
			};
}

const HANDOFF_STATUS_VIEWS: Record<RunHandoffStatus, Omit<SummaryFactView, "detail">> = {
	done: { label: "Done", tone: "success" },
	partial: { label: "Partial", tone: "warning" },
	blocked: { label: "Blocked", tone: "danger" },
};

/** The agent's self-reported handoff status as a labelled tone. */
export function handoffStatusView(status: RunHandoffStatus): Omit<SummaryFactView, "detail"> {
	return HANDOFF_STATUS_VIEWS[status];
}

const PULL_REQUEST_TONES: Record<PullRequestLifecycle, SummaryTone> = {
	merged: "success",
	open: "warning",
	closed_unmerged: "danger",
};

/** A PR's lifecycle as a tone; null (not polled yet) stays neutral. */
export function pullRequestTone(state: PullRequestLifecycle | null): SummaryTone {
	return state === null ? "neutral" : PULL_REQUEST_TONES[state];
}

function countChecks(n: number): string {
	return `${n} check${n === 1 ? "" : "s"}`;
}

/**
 * The PR head commit's check summary (namphuongtran/warren#41) as a labelled
 * tone. Null means the merge watcher has not read the checks yet.
 */
export function prChecksView(checks: RunPrChecks | null): SummaryFactView {
	if (checks === null) {
		return {
			label: "Not read yet",
			tone: "neutral",
			detail: "Warren reads the checks each time it polls the pull request.",
		};
	}
	const failed = countChecks(checks.failing.length);
	switch (checks.state) {
		case "passing":
			return {
				label: "Passing",
				tone: "success",
				detail: "Every check passed on the pull request's head commit.",
			};
		case "failing":
			return {
				label: "Failing",
				tone: "danger",
				detail: `${failed} failed on the pull request's head commit.`,
			};
		case "pending":
			return {
				label: "Running",
				tone: "warning",
				detail:
					checks.failing.length > 0
						? `${failed} failed so far; the rest are still running.`
						: "Checks are still running on the pull request's head commit.",
			};
		case "none":
			return {
				label: "No checks",
				tone: "neutral",
				detail:
					"The forge reported no checks for the pull request's head commit, or this forge credential cannot read checks.",
			};
	}
}

// Derived from the wire type, not a copy: api/types.ts sits at its size ceiling.
type PrReview = NonNullable<RunPrChecks["review"]>;

const PR_REVIEW_VIEWS: Record<PrReview["state"], SummaryFactView> = {
	approved: {
		label: "Approved",
		tone: "success",
		detail: "The reviewer approved the pull request's head commit.",
	},
	changes_requested: {
		label: "Changes requested",
		tone: "danger",
		detail: "The reviewer asked for changes on the pull request's head commit.",
	},
	pending: {
		label: "In review",
		tone: "warning",
		detail: "A review of the pull request's head commit is in progress.",
	},
	failed: {
		label: "Review failed",
		tone: "danger",
		detail: "The review ended without a verdict.",
	},
};

/**
 * The review verdict on the PR head commit (namphuongtran/warren#38), read
 * with the checks. The status description, when the reviewer wrote one, is
 * the detail line.
 */
export function prReviewView(checks: RunPrChecks | null): SummaryFactView {
	if (checks === null) {
		return {
			label: "Not read yet",
			tone: "neutral",
			detail: "Warren reads the review each time it polls the pull request.",
		};
	}
	if (checks.review === undefined) {
		return {
			label: "No review",
			tone: "neutral",
			detail:
				"No review verdict on the pull request's head commit, or this forge credential cannot read commit statuses.",
		};
	}
	const view = PR_REVIEW_VIEWS[checks.review.state];
	const words = checks.review.description?.trim() ?? "";
	return words === "" ? view : { ...view, detail: words };
}

/** One open question from a blocked handoff, with the operator's answer. */
export interface AnsweredQuestion {
	readonly question: string;
	readonly answer: string;
}

/** What a continuation of a blocked run is told. */
export interface BlockedRunAnswers {
	/** The blocked run's own prompt: the server never carries it forward. */
	readonly task: string;
	/**
	 * The blocked handoff's summary. A planner without an issue queue keeps
	 * its draft spec only here, so the continuation must quote it.
	 */
	readonly handoffSummary: string;
	readonly answers: readonly AnsweredQuestion[];
}

/**
 * The follow-up prompt for a continuation of a blocked run
 * (namphuongtran/warren#38, #25): the original task, the blocked run's
 * handoff summary, then each open question with the operator's answer, in
 * the handoff's order.
 */
export function answeredContinuationPrompt(input: BlockedRunAnswers): string {
	const items = input.answers.map((a, i) => {
		const answer = a.answer.trim();
		const body =
			answer === ""
				? "none given. Decide, and record the decision in your handoff."
				: answer.replaceAll("\n", "\n   ");
		return `${i + 1}. ${a.question}\n   Answer: ${body}`;
	});
	return [
		input.task,
		"",
		"## The previous run's handoff summary",
		"",
		input.handoffSummary.trim(),
		"",
		"## Answers to your open questions",
		"",
		"The previous run stopped blocked on these questions. The operator answered them:",
		"",
		...items,
	].join("\n");
}

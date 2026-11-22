/**
 * CI-fixer poller orchestration (warren-0b75; migrated onto the Forge seam
 * in warren-0b49, plan pl-d1c9 step 12).
 *
 * Ties the pure helpers landed by warren-05ea into one per-project pass the
 * scheduler tick (`src/triggers/tick.ts`) drives every cycle for projects
 * with `ciFixer.enabled`:
 *
 *   1. For each PR candidate (one per `runs.pr_url` not already recorded
 *      terminal, surfaced by `RunsRepo.listPrCandidatesByProject`), read
 *      the PR lifecycle with `forge.getPullRequest`. A merged or closed PR
 *      is recorded on the opener run (`runs.pr_state`) and skipped as
 *      `not_open` with no check-run request (namphuongtran/warren#59).
 *      For an open PR, reconstruct the head ref from the opener run's
 *      branch (`${prefix}/${runId}` via `composeRunBranch`).
 *   2. `forge.listChecks` + `classifyCheckRuns` decide whether CI is failing.
 *   3. `fixAttemptHistoryByPrUrl` feeds `decideDispatch`'s cooldown +
 *      max-retries gates.
 *   4. On `dispatch`, `buildFixerPrompt` composes the prompt and the
 *      injected `spawn` seam fires a `ci-fixer` run against the PR branch,
 *      back-linked to the opener via `parentRunId`.
 *
 * Pure-ish: all I/O (the boot-resolved `Forge`, attempt-history read, spawn)
 * is injected, so the orchestration is unit-testable without a live stack.
 * The poller carries the intended `targetBranch` on the spawn input so the
 * spawn/reap wiring honors it.
 *
 * §5 capability degradations (forge-contract.md §5):
 *   - `capabilities.checkRuns === false` (a fine-grained PAT cannot reach
 *     the Checks API at all, §6.7) → every candidate skips with reason
 *     `unsupported` and NO forge call is made; the pass layer rate-limits
 *     the notice to once per project. An unsupported forge must not be
 *     indistinguishable from a network blip (per-PR per-tick error logs
 *     forever) — that was the pre-migration bug.
 *   - `capabilities.jobLogs === false` → the log tail resolves to null and
 *     `buildFixerPrompt` keeps its existing "No CI log could be fetched"
 *     fallback. The capability gap never blocks a dispatch.
 */

import type { Forge, PullRequestLifecycle, RepoRef } from "../forge/contract.ts";
import { composeRunBranch } from "../runs/branch.ts";
import { mapLifecycle, type PollTarget, resolvePollTarget } from "../runs/pr-merge.ts";
import { type CheckRun, classifyCheckRuns, tailLogLines } from "./check-runs.ts";
import { buildFixerPrompt, type CiFixerSettings, decideDispatch } from "./dispatch.ts";

/** Trigger string stamped on poller-dispatched runs — the discriminator
 * `RunsRepo.fixAttemptHistoryByPrUrl` filters on to count prior attempts. */
export const CI_FIXER_TRIGGER = "ci-fixer";

/** System-event kind appended to the opener run when a fixer is dispatched. */
export const CI_FIXER_DISPATCHED_EVENT = "ci_fixer.dispatched";

/**
 * Byte budget per requested log line for `forge.fetchJobLogTail` (the seam
 * tails bytes; the domain budget is lines). Generous on purpose — the
 * domain re-tails to the exact line count via `tailLogLines`.
 */
const APPROX_BYTES_PER_LOG_LINE = 512;

export interface CiFixerCandidate {
	/** The run that opened the PR; its branch is the PR head ref + the
	 * `parentRunId` the dispatched fixer back-links to. */
	readonly runId: string;
	readonly prUrl: string;
}

export interface CiFixerAttemptHistory {
	readonly attempts: number;
	readonly lastAttemptAt: string | null;
}

export type FixAttemptHistoryFn = (prUrl: string) => Promise<CiFixerAttemptHistory>;

export interface CiFixerSpawnInput {
	readonly prompt: string;
	/** Opener run the PR belongs to; the fixer continues from its branch. */
	readonly parentRunId: string;
	/** PR head branch the fixer must push to so the PR's CI re-runs
	 * (honored by spawn/reap in warren-a993). */
	readonly targetBranch: string;
	readonly prUrl: string;
}

export type CiFixerSpawnFn = (input: CiFixerSpawnInput) => Promise<{ runId: string }>;

/** A lifecycle the forge reports for a PR that will never take a fix. */
export type TerminalPrLifecycle = Exclude<PullRequestLifecycle, "open">;

/**
 * Persist a terminal PR lifecycle onto the opener run (`runs.pr_state`), so
 * the candidate query drops the PR on later ticks without a forge request
 * (namphuongtran/warren#59). `mergedAt` is ISO, null unless merged.
 */
export type RecordPrTerminalFn = (
	runId: string,
	lifecycle: TerminalPrLifecycle,
	mergedAt: string | null,
) => Promise<void>;

/**
 * `unsupported` (warren-0b49, §5): the forge cannot read check runs at all
 * (`capabilities.checkRuns === false`, or a defensive `unsupported` error
 * from `listChecks`). Distinct from a transient fetch failure — the pass
 * layer rate-limits it to one notice per project.
 *
 * `not_open` (namphuongtran/warren#59): the forge reports the PR merged or
 * closed. The poller records that state, so the PR leaves the candidate set
 * and the skip is logged once, not every tick.
 */
export type CiFixerSkipReason =
	| "disabled"
	| "not_failing"
	| "cooldown"
	| "max_retries"
	| "unsupported"
	| "not_open";

export type CiFixerPollResult =
	| {
			readonly kind: "dispatched";
			readonly prUrl: string;
			readonly runId: string;
			readonly parentRunId: string;
	  }
	| { readonly kind: "skipped"; readonly prUrl: string; readonly reason: CiFixerSkipReason }
	| { readonly kind: "error"; readonly prUrl: string; readonly reason: string };

export interface PollProjectCiFixerInput {
	readonly candidates: readonly CiFixerCandidate[];
	readonly settings: CiFixerSettings;
	/** Resolved run-branch prefix for this project (project default > env >
	 * built-in), used to reconstruct each PR's head ref. */
	readonly branchPrefix: string;
	/**
	 * Boot-resolved forge (`ServerDeps.forge`) — never a per-tick instance.
	 * Owns the check-runs read, the log tail, and credential minting.
	 */
	readonly forge: Forge;
	readonly history: FixAttemptHistoryFn;
	readonly spawn: CiFixerSpawnFn;
	readonly recordTerminal: RecordPrTerminalFn;
	readonly now: Date;
	/** Max CI-log lines to splice into the fixer prompt (warren-a993).
	 * `ciFixer.logTailLines` from project config. `<= 0` disables the fetch. */
	readonly logTailLines: number;
	/** Stop after this many successful dispatches; omit for no limit. */
	readonly maxDispatches?: number;
}

/**
 * Run one CI-fixer pass over a project's PR candidates. Returns one result
 * per candidate (the tick logs them; dispatches additionally get a durable
 * system event). Never throws on a per-candidate failure — a bad PR url or
 * a forge error is captured as an `error` result so one PR can't derail the
 * project's pass.
 */
export async function pollProjectCiFixer(
	input: PollProjectCiFixerInput,
): Promise<CiFixerPollResult[]> {
	const results: CiFixerPollResult[] = [];
	let dispatched = 0;
	for (const candidate of input.candidates) {
		if (input.maxDispatches !== undefined && dispatched >= input.maxDispatches) break;
		const result = await pollCandidate(input, candidate);
		results.push(result);
		if (result.kind === "dispatched") dispatched += 1;
	}
	return results;
}

async function pollCandidate(
	input: PollProjectCiFixerInput,
	candidate: CiFixerCandidate,
): Promise<CiFixerPollResult> {
	const target = resolvePollTarget(input.forge, candidate.prUrl);
	if (target.kind === "unparseable") {
		return { kind: "error", prUrl: candidate.prUrl, reason: "unparseable PR url" };
	}

	// §5 checkRuns degradation: stay idle — no forge call, one skip result
	// per candidate, and the pass layer emits ONE notice per project.
	if (!input.forge.capabilities.checkRuns) {
		return { kind: "skipped", prUrl: candidate.prUrl, reason: "unsupported" };
	}

	// Open-only rule (namphuongtran/warren#59): read the lifecycle before
	// any check-run request, so a merged or closed PR costs no `listChecks`
	// and can never take a fixer onto a branch that outlived its merge.
	const notOpen = await gateOnOpen(input, candidate, target);
	if (notOpen !== null) return notOpen;

	const ref = target.ref;
	const headRef = composeRunBranch(input.branchPrefix, candidate.runId);
	const fetched = await input.forge.listChecks(ref, headRef);
	if (!fetched.ok) {
		// Defensive: a provider that reports the capability but still returns
		// `unsupported` degrades the same way, not as a per-tick error.
		if (fetched.error.kind === "unsupported") {
			return { kind: "skipped", prUrl: candidate.prUrl, reason: "unsupported" };
		}
		return { kind: "error", prUrl: candidate.prUrl, reason: fetched.error.detail };
	}

	const { verdict, failures } = classifyCheckRuns(fetched.value.runs);
	const history = await input.history(candidate.prUrl);
	const decision = decideDispatch({
		settings: input.settings,
		verdict,
		history,
		now: input.now,
	});
	if (decision.kind === "skip") {
		return { kind: "skipped", prUrl: candidate.prUrl, reason: decision.reason };
	}

	const logTail = await resolveLogTail(input, ref, failures);
	const prompt = buildFixerPrompt({ prUrl: candidate.prUrl, failures, logTail });
	const spawned = await input.spawn({
		prompt,
		parentRunId: candidate.runId,
		targetBranch: headRef,
		prUrl: candidate.prUrl,
	});
	return {
		kind: "dispatched",
		prUrl: candidate.prUrl,
		runId: spawned.runId,
		parentRunId: candidate.runId,
	};
}

/**
 * Read the PR's lifecycle. Returns null for an open PR (keep polling it),
 * a `not_open` skip for a merged or closed PR after recording that state on
 * the opener run, or an `error` when the read or the record fails. The
 * forge's own retries are not repeated here: the next tick reads again.
 */
async function gateOnOpen(
	input: PollProjectCiFixerInput,
	candidate: CiFixerCandidate,
	target: Extract<PollTarget, { kind: "resolved" }>,
): Promise<CiFixerPollResult | null> {
	const read = await input.forge.getPullRequest(target.ref, target.pr);
	if (!read.ok) {
		return { kind: "error", prUrl: candidate.prUrl, reason: read.error.detail };
	}
	const polled = mapLifecycle(read.value);
	if (polled.kind === "open") return null;
	const mergedAt = polled.kind === "merged" ? polled.mergedAt : null;
	try {
		await input.recordTerminal(candidate.runId, polled.kind, mergedAt);
	} catch (err) {
		const detail = err instanceof Error ? err.message : String(err);
		return { kind: "error", prUrl: candidate.prUrl, reason: `recording PR state: ${detail}` };
	}
	return { kind: "skipped", prUrl: candidate.prUrl, reason: "not_open" };
}

/**
 * Resolve the CI log tail to splice into the fixer prompt (warren-a993).
 * Walks the failing check-runs' opaque `jobId`s and returns the first
 * non-empty log tail. A null result — logging disabled
 * (`logTailLines <= 0`), `capabilities.jobLogs === false` (§5 — the prompt
 * fallback is preserved, not replaced), no job id, or every fetch failing —
 * leaves `buildFixerPrompt` to fall back to the check-name-only prompt.
 * Log extraction never blocks a dispatch.
 */
async function resolveLogTail(
	input: PollProjectCiFixerInput,
	ref: RepoRef,
	failures: readonly CheckRun[],
): Promise<string | null> {
	if (input.logTailLines <= 0) return null;
	if (!input.forge.capabilities.jobLogs) return null;
	for (const failure of failures) {
		if (failure.jobId === null) continue;
		const result = await input.forge.fetchJobLogTail(
			ref,
			failure.jobId,
			input.logTailLines * APPROX_BYTES_PER_LOG_LINE,
		);
		if (!result.ok || result.value === null) continue;
		const tail = tailLogLines(result.value, input.logTailLines);
		if (tail !== null) return tail;
	}
	return null;
}

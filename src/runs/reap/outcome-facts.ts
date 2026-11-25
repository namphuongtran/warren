/**
 * Reap-time outcome facts (warren-ab2b / pl-103e step 5): persist what the
 * reap pipeline MEASURED at finalize onto the run row — `commits_ahead`
 * (finalize's own count) plus the parsed `git diff --numstat` totals
 * (`files_changed` / `insertions` / `deletions`), plus `base_sha` — the
 * resolved workspace base SHA (warren-b19e), the merge-base of the diff
 * base and the workspace HEAD, read in the same pass.
 *
 * Facts are recorded, not interpreted: no derived judgments, and NULL means
 * unknown — a skipped/failed finalize, a missing base branch, or a diff
 * that could not be measured — never zero. Historical rows predate the
 * columns and stay NULL.
 *
 * The diff is read off the host worktree under LocalProvider (`base..HEAD`,
 * the workspace is still live — terminate runs after the pipeline) or off
 * the pushed run branch fetched into the project clone under K8s (the same
 * warren-ab66 trick `pr-context.ts` uses for PR bodies). Best-effort
 * throughout: any git or fetch failure degrades that measurement to NULL.
 *
 * The same pass reads the zero-context unified diff for the shortcut-flag
 * scan (namphuongtran/warren#37), so K8s fetches the branch once.
 */

import type { Forge } from "../../forge/contract.ts";
import { mintGitCredential } from "../../forge/credentials.ts";
import { authenticatedCloneUrl } from "../../workspace/git/clone-url.ts";
import type { GitSpawnCredential } from "../../workspace/git/credential-env.ts";
import type { BoundBridgeLogger } from "../stream/index.ts";
import type { ReapExec } from "./types.ts";

/** The three parsed `git diff --numstat` totals. */
export interface DiffStats {
	readonly filesChanged: number;
	readonly insertions: number;
	readonly deletions: number;
}

export interface RecordOutcomeFactsInput {
	readonly runId: string;
	/** Host workspace path (LocalProvider) or `null` under K8s. */
	readonly workspacePath: string | null;
	/** The run's pushed branch (K8s clone-fetch source); null = none. */
	readonly branch: string | null;
	/**
	 * The base ref for the `base..head` diff — finalize's reported
	 * `commitsAheadBase` (the ref it counted `commits_ahead` against; a SHA on
	 * a ref-dispatch repair run, warren-ba08) else the run's base branch;
	 * null = unmeasurable (matches finalize).
	 */
	readonly baseBranch: string | null;
	readonly project: { readonly gitUrl: string; readonly localPath: string };
	/** finalize's measured count; the fact persisted verbatim. */
	readonly commitsAhead: number | null;
	/** Whether finalize pushed the branch (gates the K8s clone fetch). */
	readonly branchPushed: boolean;
	readonly exec: ReapExec;
	/** Boot-resolved forge; mints the K8s clone-fetch credential. */
	readonly forge?: Forge;
	readonly log: BoundBridgeLogger;
	/** The RunsRepo write seam (delegated so tests can stub it). */
	readonly setOutcomeFacts: (
		id: string,
		facts: {
			commitsAhead: number | null;
			baseSha: string | null;
			filesChanged: number | null;
			insertions: number | null;
			deletions: number | null;
		},
	) => Promise<unknown>;
}

/** What {@link recordOutcomeFacts} read: the totals and the diff text, each null when unreadable. */
export interface OutcomeReading {
	readonly stats: DiffStats | null;
	/** `git diff --unified=0` text for the shortcut scan; "" for a known-empty range. */
	readonly diff: string | null;
}

/** The diff totals, diff text, and resolved base SHA, read in one pass. */
interface OutcomeMeasurement extends OutcomeReading {
	/** Resolved workspace base SHA (warren-b19e); null = unmeasurable. */
	readonly baseSha: string | null;
}

const UNMEASURED: OutcomeMeasurement = { stats: null, diff: null, baseSha: null };

/** Temp-ref namespace for the K8s clone fetch; deleted after the read. */
const FETCH_REF_PREFIX = "refs/warren/outcome-facts/";

/**
 * Measure the diff totals and the resolved base SHA, then persist all five
 * facts. Returns the measured stats and diff text (null when unmeasurable) so
 * the pipeline can carry them on. The row write itself is best-effort
 * bookkeeping: a failure is logged, never thrown out of reap.
 */
export async function recordOutcomeFacts(input: RecordOutcomeFactsInput): Promise<OutcomeReading> {
	const { stats, diff, baseSha } = await measureOutcome(input);
	try {
		await input.setOutcomeFacts(input.runId, {
			commitsAhead: input.commitsAhead,
			baseSha,
			filesChanged: stats?.filesChanged ?? null,
			insertions: stats?.insertions ?? null,
			deletions: stats?.deletions ?? null,
		});
	} catch (err) {
		input.log.warn(
			{
				event: "reap.outcome_facts_write_failed",
				runId: input.runId,
				err: err instanceof Error ? err.message : String(err),
			},
			"outcome facts measured but the run row could not be stamped",
		);
	}
	return { stats, diff };
}

/**
 * Resolve the diff totals and the resolved workspace base SHA
 * (warren-b19e) for the run's `base..head` range. `commitsAhead === 0`
 * means the range is empty by finalize's own measurement, so the totals
 * are known zeros without a git read; `commitsAhead === null` means
 * finalize never measured, so the diff is unknown too. The base SHA is
 * measured only where a git read actually happens (alongside the diff),
 * as the merge-base of the diff base and the workspace HEAD — the commit
 * the workspace was actually cut at, pin or not.
 */
async function measureOutcome(input: RecordOutcomeFactsInput): Promise<OutcomeMeasurement> {
	if (input.commitsAhead === null) return UNMEASURED;
	if (input.commitsAhead === 0) {
		return { stats: { filesChanged: 0, insertions: 0, deletions: 0 }, diff: "", baseSha: null };
	}
	if (input.baseBranch === null) return UNMEASURED;
	// LocalProvider: read straight off the still-live host worktree.
	if (input.workspacePath !== null) {
		return readRange(input.exec, input.workspacePath, input.baseBranch, "HEAD");
	}
	// K8s: no host worktree — fetch the pushed branch into the project clone
	// and read the range there (warren-ab66 posture). Requires the push to
	// have landed and a forge credential for the fetch.
	if (!input.branchPushed || input.branch === null || input.forge === undefined) {
		return UNMEASURED;
	}
	const gitCredential = await mintGitCredential(input.forge, input.project.gitUrl).catch(() => {
		return undefined;
	});
	if (gitCredential === undefined) return UNMEASURED;
	return numstatFromClone(input, gitCredential);
}

/** Fetch `branch` into the clone under a private temp ref, read numstat, delete the ref. */
async function numstatFromClone(
	input: RecordOutcomeFactsInput,
	gitCredential: GitSpawnCredential,
): Promise<OutcomeMeasurement> {
	const { branch, baseBranch, runId, exec, project } = input;
	if (branch === null || baseBranch === null) return UNMEASURED;
	const tempRef = `${FETCH_REF_PREFIX}${runId}`;
	const url = authenticatedCloneUrl(project.gitUrl, gitCredential);
	try {
		await exec.run("git", ["fetch", "--no-tags", "--force", url, `${branch}:${tempRef}`], {
			cwd: project.localPath,
			timeoutMs: 30_000,
		});
	} catch {
		return UNMEASURED;
	}
	try {
		return await readRange(exec, project.localPath, baseBranch, tempRef);
	} finally {
		try {
			await exec.run("git", ["update-ref", "-d", tempRef], {
				cwd: project.localPath,
				timeoutMs: 10_000,
			});
		} catch {
			// Best-effort cleanup — a leaked temp ref is harmless (`--force`
			// overwrites it on the next reap of the same run id).
		}
	}
}

/** Read the totals, the merge-base, and the unified diff of `base..head` in parallel. */
async function readRange(
	exec: ReapExec,
	cwd: string,
	baseRef: string,
	headRef: string,
): Promise<OutcomeMeasurement> {
	const [stats, baseSha, diff] = await Promise.all([
		numstat(exec, cwd, baseRef, headRef),
		mergeBase(exec, cwd, baseRef, headRef),
		unifiedDiff(exec, cwd, baseRef, headRef),
	]);
	return { stats, diff, baseSha };
}

/**
 * Run `git diff --unified=0 base...head` for the shortcut scan; null on
 * failure, including a diff past exec's output buffer (a huge diff is not
 * scanned). Three dots diff from the merge-base, so work that landed on the
 * base branch after dispatch never reads as the agent's. Renames are
 * detected so a moved test file is not a deleted one.
 */
async function unifiedDiff(
	exec: ReapExec,
	cwd: string,
	baseRef: string,
	headRef: string,
): Promise<string | null> {
	try {
		const out = await exec.run(
			"git",
			["diff", "--unified=0", "--no-color", "--no-ext-diff", "-M", `${baseRef}...${headRef}`],
			{ cwd, timeoutMs: 10_000 },
		);
		return out.stdout;
	} catch {
		return null;
	}
}

/** Run `git merge-base base head` in `cwd`; null on failure (best-effort, warren-b19e). */
async function mergeBase(
	exec: ReapExec,
	cwd: string,
	baseRef: string,
	headRef: string,
): Promise<string | null> {
	try {
		const out = await exec.run("git", ["merge-base", baseRef, headRef], {
			cwd,
			timeoutMs: 10_000,
		});
		const sha = out.stdout.trim();
		return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
	} catch {
		return null;
	}
}

/** Run `git diff --numstat base..head` in `cwd` and parse the totals. */
async function numstat(
	exec: ReapExec,
	cwd: string,
	baseRef: string,
	headRef: string,
): Promise<DiffStats | null> {
	try {
		const out = await exec.run("git", ["diff", "--numstat", `${baseRef}..${headRef}`], {
			cwd,
			timeoutMs: 10_000,
		});
		return parseNumstat(out.stdout);
	} catch {
		return null;
	}
}

/**
 * Parse `git diff --numstat` output: one `<added>\t<deleted>\t<path>` row
 * per file, with `-` for binary files (counted as a changed file with zero
 * line deltas, matching `git diff --stat`'s "Bin 0 -> N bytes" row).
 */
export function parseNumstat(stdout: string): DiffStats {
	let filesChanged = 0;
	let insertions = 0;
	let deletions = 0;
	for (const raw of stdout.split("\n")) {
		const line = raw.trimEnd();
		if (line === "") continue;
		const [added, removed] = line.split("\t");
		if (added === undefined || removed === undefined) continue;
		filesChanged++;
		if (added !== "-") insertions += Number.parseInt(added, 10) || 0;
		if (removed !== "-") deletions += Number.parseInt(removed, 10) || 0;
	}
	return { filesChanged, insertions, deletions };
}

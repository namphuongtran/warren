/**
 * Local salvage-before-destroy (warren-cd3b) — the LocalProvider half of the
 * salvage step. Runs inside reap between a FAILED finalize (the branch push
 * never landed) and `runWorkspaceDestroy`, while the host-side workspace is
 * still reachable. Under K8s this step cannot run (the workspace is the pod's
 * `emptyDir`) — the pod salvages itself and POSTs to `/runs/:id/salvage`; see
 * `src/runtime/salvage.ts` for the shared vocabulary and the runtime split.
 *
 * Two capture forms, tried in order of operator convenience:
 *
 *   1. RESCUE REF — `git push origin HEAD:warren/rescue/<runId>` from the
 *      workspace. Rides the same push path that just failed, so a rejection
 *      (push protection, auth) is expected sometimes; the failure is noted,
 *      not thrown.
 *   2. BUNDLE — `git bundle create <salvageDir>/<runId>.bundle <base>..HEAD`
 *      written to durable warren-side storage. Survives a push-protection
 *      rejection because it never touches origin. Skipped when no salvageDir
 *      was threaded (tests).
 *
 * DROPPED COMMIT (namphuongtran/warren#8): a run that ends `succeeded` with a
 * dirty tree and zero commits pushed an empty branch, so its work exists only
 * as uncommitted changes. `includeUncommitted` folds that tree onto a
 * throwaway ref first (see `captureUncommittedWork`), and both capture forms
 * then read that ref instead of `HEAD`. The K8s pod does the same in-pod
 * (`empty_push_dirty`, `src/runtime/k8s/salvage.ts`).
 *
 * The outcome drives reap's destroy gating: a successful capture (either form)
 * means the work is safe and the workspace CAN be destroyed; a total failure
 * keeps the old preserve-the-workspace skip, now paired with an explicit
 * `reap.workspace_salvage_failed` event so the unrecoverable determination is
 * operator-visible instead of silent.
 */

import { copyFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
	gitRepoContextScrubEnv,
	warrenCommitIdentityArgs,
	warrenCommitIdentityEnv,
} from "../../bot-identity.ts";
import type { RunRow } from "../../db/schema.ts";
import type { Forge } from "../../forge/contract.ts";
import { mintGitCredential } from "../../forge/credentials.ts";
import { rescueBranchFor, salvageBundlePath, salvageCommitMessage } from "../../runtime/salvage.ts";
import type { GitSpawnCredential } from "../../workspace/git/credential-env.ts";
import { gitCredentialGitEnv } from "../../workspace/git/credential-env.ts";
import type { ReapExec, ReapFs, ReapStep } from "./types.ts";
import { HARNESS_STATE_PREFIXES, WARREN_RUNTIME_SCRATCH } from "./util.ts";

export interface WorkspaceSalvageInput {
	readonly runId: string;
	readonly workspacePath: string;
	/** Base ref for the bundle range; null ⇒ bundle the full `HEAD` history. */
	readonly baseBranch: string | null;
	/** Durable dir for the bundle capture; absent ⇒ only the rescue ref is tried. */
	readonly salvageDir?: string;
	/**
	 * Per-spawn minted git credential for the rescue-ref push (warren-4e1c,
	 * forge-contract.md §4 — minted by the caller immediately before this
	 * call via `mintGitCredential`, never held on a config object).
	 * Undefined ⇒ anonymous push, the pre-forge behavior for a forge that owns
	 * no credential for the URL.
	 */
	readonly gitCredential?: GitSpawnCredential;
	/**
	 * Fold the dirty tree into a commit on a throwaway ref before capturing
	 * (a dropped commit: the work was never committed). Absent ⇒ capture `HEAD`.
	 */
	readonly includeUncommitted?: boolean;
	readonly exec: ReapExec;
	readonly fs: ReapFs;
}

/** What a salvage attempt captured. Both null ⇒ nothing was saved. */
export interface WorkspaceSalvageOutcome {
	/** The rescue branch on origin (`warren/rescue/<runId>`), when pushed. */
	readonly rescueRef: string | null;
	/** The durable bundle path, when captured. */
	readonly bundlePath: string | null;
	/** Per-attempt failure notes (never secret material — git stderr only). */
	readonly errors: string[];
}

function errMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/**
 * Attempt both capture forms against the live workspace. Never throws — every
 * failure lands in `errors` and the caller decides (via the two nulls) whether
 * the run's work is recoverable.
 */
export async function salvageWorkspace(
	input: WorkspaceSalvageInput,
): Promise<WorkspaceSalvageOutcome> {
	const errors: string[] = [];
	let rescueRef: string | null = null;
	let bundlePath: string | null = null;

	const branch = rescueBranchFor(input.runId);
	// What both capture forms read: `HEAD`, or the captured dirty-tree commit.
	let source = "HEAD";
	if (input.includeUncommitted === true) {
		try {
			source = `refs/heads/${branch}`;
			await captureUncommittedWork(input, source);
		} catch (err) {
			// Without the commit there is nothing to capture: HEAD is the base.
			errors.push(`uncommitted-work capture failed: ${errMessage(err)}`);
			return { rescueRef, bundlePath, errors };
		}
	}
	try {
		await input.exec.run("git", ["push", "origin", `${source}:refs/heads/${branch}`], {
			cwd: input.workspacePath,
			timeoutMs: 60_000,
			env: gitCredentialGitEnv(input.gitCredential),
		});
		rescueRef = branch;
	} catch (err) {
		errors.push(`rescue push to ${branch} failed: ${errMessage(err)}`);
	}

	if (rescueRef === null && input.salvageDir !== undefined) {
		const range =
			input.baseBranch !== null && input.baseBranch !== ""
				? `${input.baseBranch}..${source}`
				: source;
		try {
			// Shared resolver, not a bare join (warren-7c1e): this run id comes
			// off a db row rather than a route param, but the containment check
			// belongs to the sink so every salvage writer inherits it. Inside the
			// try because this function reports through `errors` and never throws.
			const target = salvageBundlePath(input.salvageDir, input.runId);
			await input.fs.mkdirp(input.salvageDir);
			await input.exec.run("git", ["bundle", "create", target, range], {
				cwd: input.workspacePath,
				timeoutMs: 60_000,
			});
			bundlePath = target;
		} catch (err) {
			// An empty range (no commits ahead — nothing to lose) fails here with
			// "Refusing to create empty bundle"; that is a fine outcome too.
			errors.push(`bundle capture (${range}) failed: ${errMessage(err)}`);
		}
	}

	return { rescueRef, bundlePath, errors };
}

export interface LocalSalvageInput {
	/** What to capture; the rescue-push credential is minted here. */
	readonly capture: Omit<WorkspaceSalvageInput, "gitCredential">;
	/** The project's clone URL; null (orphaned run) ⇒ anonymous rescue push. */
	readonly gitUrl: string | null;
	readonly forge?: Forge;
	readonly setSalvage: (
		runId: string,
		salvage: { rescueRef: string | null; bundlePath: string | null },
	) => Promise<unknown>;
	readonly emit: (kind: string, payload: unknown) => Promise<unknown>;
	readonly fail: (step: ReapStep, err: unknown) => Promise<void>;
	readonly log: { warn: (obj: Record<string, unknown>, msg: string) => void };
}

/**
 * The reap-side local salvage step (LocalProvider and DockerProvider, whose
 * workspace is host-reachable): mint the rescue-push credential, capture the
 * work, stamp the run row, and emit `reap.workspace_salvaged` or
 * `reap.workspace_salvage_failed`. Never throws.
 */
export async function salvageLocalWorkspace(
	input: LocalSalvageInput,
): Promise<WorkspaceSalvageOutcome> {
	// warren-4e1c: mint the rescue-push credential immediately before the
	// salvage spawn (forge-contract.md §4 — minted, never held). A mint
	// failure is recorded and degrades to an anonymous push (which fails
	// closed on a private repo) rather than skipping the salvage.
	let gitCredential: GitSpawnCredential | undefined;
	if (input.forge !== undefined && input.gitUrl !== null) {
		try {
			gitCredential = await mintGitCredential(input.forge, input.gitUrl);
		} catch (err) {
			await input.fail("branch_push", err);
		}
	}
	const { capture, setSalvage, emit, log } = input;
	const salvage = await salvageWorkspace({
		...capture,
		...(gitCredential !== undefined ? { gitCredential } : {}),
	});
	if (salvage.rescueRef === null && salvage.bundlePath === null) {
		await emit("reap.workspace_salvage_failed", { errors: salvage.errors });
		return salvage;
	}
	try {
		await setSalvage(capture.runId, {
			rescueRef: salvage.rescueRef,
			bundlePath: salvage.bundlePath,
		});
	} catch (err) {
		// The row write is bookkeeping; the capture itself is the artifact.
		log.warn(
			{ event: "reap.salvage_stamp_failed", err: errMessage(err) },
			"salvage captured but the run row could not be stamped",
		);
	}
	await emit("reap.workspace_salvaged", {
		rescueRef: salvage.rescueRef,
		bundlePath: salvage.bundlePath,
	});
	return salvage;
}

/** Harness scratch and warren runtime files: not agent work, never captured. */
const NOT_AGENT_WORK: readonly string[] = [...HARNESS_STATE_PREFIXES, ...WARREN_RUNTIME_SCRATCH];

/**
 * Commit the workspace's dirty tree onto `ref` (the local rescue branch, so the
 * bundle's head and the pushed branch read the same) without touching the
 * agent's checkout: the tree is staged into a TEMPORARY index, written with
 * `commit-tree` under the canonical bot identity (`src/bot-identity.ts`,
 * Article VII), and pointed at by the ref. Harness scratch (`.claude/`, …) is
 * excluded: it is not agent work and may hold harness settings. Every spawn
 * carries the repo-context scrub so an inherited `GIT_DIR` can never redirect
 * it. Throws on any git failure (the caller records it).
 */
async function captureUncommittedWork(input: WorkspaceSalvageInput, ref: string): Promise<void> {
	const indexFile = join(tmpdir(), `warren-salvage-${input.runId}.index`);
	const git = async (args: string[], env: Record<string, string> = {}): Promise<string> => {
		const out = await input.exec.run("git", args, {
			cwd: input.workspacePath,
			timeoutMs: 60_000,
			env: { ...gitRepoContextScrubEnv(), ...env },
		});
		return out.stdout.trim();
	};
	const indexEnv = { GIT_INDEX_FILE: indexFile };
	try {
		// Seed from the agent's own index: its stat cache keeps `add -A` from
		// rehashing every tracked file of a large repo. No index ⇒ start at HEAD.
		try {
			const agentIndex = await git(["rev-parse", "--git-path", "index"]);
			await copyFile(resolve(input.workspacePath, agentIndex), indexFile);
		} catch {
			await git(["read-tree", "HEAD"], indexEnv);
		}
		const excludes = NOT_AGENT_WORK.map((p) => `:(exclude)${p}`);
		await git(["add", "-A", "--", ".", ...excludes], indexEnv);
		const tree = await git(["write-tree"], indexEnv);
		const commit = await git(
			[
				...warrenCommitIdentityArgs(),
				"commit-tree",
				tree,
				"-p",
				"HEAD",
				"-m",
				salvageCommitMessage(input.runId),
			],
			warrenCommitIdentityEnv(),
		);
		await git(["update-ref", ref, commit]);
	} finally {
		await rm(indexFile, { force: true }).catch(() => {});
	}
}

/* ----------------------------------------------------------------------- */
/* Pod-side salvage surfacing (K8s)                                         */
/* ----------------------------------------------------------------------- */

/**
 * warren-5ea1 (k8s): the control plane cannot reach the pod's emptyDir, so
 * reap cannot capture anything itself — but the pod may have POSTed a
 * self-salvage (`/runs/:id/salvage` intake stamps the run row) before
 * exiting. Surface whatever landed so the terminal record names the
 * recovery path at a glance, and let the destroy proceed when the work is
 * already durable elsewhere (the intake's `reap.workspace_salvaged` event
 * carries the operator-visible detail; the row is re-fetched since the
 * stamp can land after reap's initial read).
 *
 * warren-985e: the arm also covers a provider_error failure — that run's
 * finalize SUCCEEDED (it pushed the branch), so `finalizeFailed` never
 * fires, but the pod's `empty_push_dirty` salvage window may still have
 * captured uncommitted work and stamped the row before posting its result.
 *
 * warren-cbd3: a provider-error run whose finalize already pushed real
 * commits has its work on origin — nothing to salvage, and claiming
 * "unrecoverable" over a branch that carries the work is wrong. Stay
 * silent; reap's `reap.branch_pushed` emit (branch / baseBranch /
 * commitsAhead payload) is the operator-visible record of where the work
 * lives.
 */
export interface PodSalvageSurfaceInput {
	readonly runId: string;
	/** The run failed on a terminal provider error (warren-edc3). */
	readonly failedFromProviderError: boolean;
	/** Finalize never completed its push (warren-495d). */
	readonly finalizeFailed: boolean;
	/** Finalize pushed the run branch. */
	readonly branchPushed: boolean;
	/** Commits the pushed branch is ahead of its base; null = unmeasured. */
	readonly commitsAhead: number | null;
	/** Re-fetch the run row — a pod salvage POST can stamp it late. */
	readonly requireRun: (runId: string) => Promise<RunRow>;
	readonly emit: (kind: string, payload: unknown) => Promise<unknown>;
}

/** Surface the pod-side salvage on the terminal record; null = nothing landed. */
export async function surfacePodSalvage(
	input: PodSalvageSurfaceInput,
): Promise<WorkspaceSalvageOutcome | null> {
	const fresh = await input.requireRun(input.runId);
	if (fresh.salvageRef !== null || fresh.salvagePath !== null) {
		await input.emit("reap.workspace_salvage_recorded", {
			source: "pod",
			rescueRef: fresh.salvageRef,
			bundlePath: fresh.salvagePath,
		});
		return { rescueRef: fresh.salvageRef, bundlePath: fresh.salvagePath, errors: [] };
	}
	if (input.failedFromProviderError && input.branchPushed && (input.commitsAhead ?? 0) > 0) {
		return null;
	}
	await input.emit("reap.workspace_salvage_failed", {
		errors: [
			input.failedFromProviderError && !input.finalizeFailed
				? "run failed with provider_error and the pod posted no salvage bundle; any uncommitted work is unrecoverable"
				: "pod reached a terminal phase without posting a finalize result or a salvage bundle; committed work is unrecoverable",
		],
	});
	return null;
}

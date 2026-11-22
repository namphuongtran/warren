/**
 * `newBranch` dispatch policy (namphuongtran/warren#58).
 *
 * A run cuts its own branch, `${prefix}/${runId}`, and reap opens a PR from
 * it. Some repositories gate the branch name itself: titcsoft/mealo's merge
 * gate blocks any branch not named `<type>/<issue>-<description>`. `newBranch`
 * names the run branch at dispatch instead. Everything else stays the same:
 * the workspace is cut from the base ref, and reap pushes the new branch and
 * opens a PR, so the Article IX gate still applies.
 *
 * Rules, enforced before any side effect:
 *
 *   1. Ref grammar and default-branch refusal, shared with `targetBranch`.
 *   2. Mutual exclusivity with `targetBranch` and `existingBranch`, which
 *      push to a branch that already exists and open no PR.
 *   3. The branch must NOT exist on the push remote yet. Pushing a fresh run
 *      onto someone's branch would fail at reap, after the agent's work.
 */

import { ValidationError } from "../core/errors.ts";
import type { SpawnOptions } from "../projects/clone.ts";
import { gitCredentialGitEnv } from "../workspace/git/credential-env.ts";
import { type BranchOnRemoteInput, isValidBranchRef, normalizeBranchRef } from "./target-branch.ts";

export interface NewBranchShapeInput {
	/** The dispatch-supplied `newBranch`. Empty or whitespace means not supplied. */
	readonly newBranch: string | undefined;
	readonly targetBranch: string | undefined;
	readonly existingBranch: string | undefined;
	/** The project's default branch, which `newBranch` may not name. */
	readonly defaultBranch: string | undefined;
}

const present = (value: string | undefined): boolean => value !== undefined && value.trim() !== "";

/**
 * Validate the shape of a `newBranch` dispatch. Returns the normalized short
 * branch name, or `undefined` when the field was not supplied. Throws
 * `ValidationError` (HTTP 400) on a conflict, a malformed name, or the
 * default branch.
 */
export function validateNewBranchShape(input: NewBranchShapeInput): string | undefined {
	if (!present(input.newBranch)) return undefined;
	const raw = input.newBranch ?? "";

	const conflicts = [
		...(present(input.targetBranch) ? ["targetBranch"] : []),
		...(present(input.existingBranch) ? ["existingBranch"] : []),
	];
	if (conflicts.length > 0) {
		throw new ValidationError(`newBranch cannot be combined with: ${conflicts.join(", ")}`, {
			recoveryHint:
				"newBranch names a fresh run branch that gets a PR. targetBranch and existingBranch " +
				"push to a branch that already exists, with no PR. Pick one.",
		});
	}

	const branch = normalizeBranchRef(raw);
	if (!isValidBranchRef(branch)) {
		throw new ValidationError(`newBranch is not a valid git branch name: '${raw}'`, {
			recoveryHint:
				"Use a branch name git accepts: no spaces, control characters, '..', '~^:?*[\\', " +
				"and no segment starting with '.' or ending in '.lock'.",
		});
	}

	const projectDefault =
		input.defaultBranch === undefined ? "" : normalizeBranchRef(input.defaultBranch);
	if (projectDefault !== "" && branch === projectDefault) {
		throw new ValidationError(`newBranch '${branch}' is the project default branch`, {
			recoveryHint: "Name a feature branch. The run opens a PR into the default branch.",
		});
	}

	return branch;
}

/**
 * Fail-closed absence check: `git ls-remote --heads <gitUrl> refs/heads/<branch>`
 * with the push credential. Throws `ValidationError` (HTTP 400) when the remote
 * already carries the branch, or when the probe fails.
 */
export async function assertBranchAbsentOnRemote(input: BranchOnRemoteInput): Promise<void> {
	const credEnv = gitCredentialGitEnv(input.gitCredential);
	const opts: SpawnOptions = {
		cwd: input.cwd,
		...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
		...(Object.keys(credEnv).length > 0 ? { env: credEnv } : {}),
	};
	const ref = `refs/heads/${input.branch}`;
	let result: Awaited<ReturnType<typeof input.spawn>>;
	try {
		result = await input.spawn(["git", "ls-remote", "--heads", input.gitUrl, ref], opts);
	} catch (err) {
		throw new ValidationError(
			`could not check that branch '${input.branch}' is free on the push remote: ${err instanceof Error ? err.message : String(err)}`,
			{ recoveryHint: "Check the credential and the repository URL, then dispatch again." },
		);
	}
	if (result.exitCode !== 0) {
		throw new ValidationError(
			`could not check that branch '${input.branch}' is free on the push remote (git ls-remote exited ${result.exitCode})`,
			{ recoveryHint: "Check the credential and the repository URL, then dispatch again." },
		);
	}
	const taken = result.stdout.split("\n").some((line) => line.trim().endsWith(`\t${ref}`));
	if (taken) {
		throw new ValidationError(`branch '${input.branch}' already exists on the push remote`, {
			recoveryHint:
				`Pick another newBranch name, or dispatch with existingBranch '${input.branch}' ` +
				"to continue the work on it (no PR).",
		});
	}
}

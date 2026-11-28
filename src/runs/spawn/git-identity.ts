/**
 * Agent git-identity env for the dispatch path (warren-4e36, warren-e7b7,
 * namphuongtran/warren#160). Extracted from `dispatch.ts` to keep that file
 * under the per-file size budget (warren-4553).
 */

import { agentGitIdentityEnv, resolveAgentGitIdentity } from "../../agent-identity.ts";
import type { EnvLike } from "./callback-env.ts";
import type { SpawnLogger } from "./types.ts";

/**
 * Put the agent's commit identity into the run env as the four
 * `GIT_AUTHOR_*` / `GIT_COMMITTER_*` vars, which git reads ahead of any
 * config. The identity is the operator's `WARREN_GIT_AUTHOR_NAME` /
 * `WARREN_GIT_AUTHOR_EMAIL` pair, or the documented default from
 * `src/agent-identity.ts` when the pair is unset or half-set.
 *
 * This is the only path that gives a run its identity, on every runtime:
 * Local, Docker, and K8s all receive the run env, and none of them gets a
 * gitconfig with a `[user]` block that warren controls. Without it the agent's
 * first `git commit` fails with "Author identity unknown" exit 128 (warren-4e36
 * on GKE) and the agent invents an author to get past it
 * (namphuongtran/warren#160). `warren up` copies its stored `~/.warren/env`
 * into `process.env` for this read (gh #1298).
 */
export function injectGitIdentityEnv(env: Record<string, string>, serverEnv: EnvLike): void {
	Object.assign(env, agentGitIdentityEnv(serverEnv));
}

/**
 * Warn once per dispatch when exactly one of `WARREN_GIT_AUTHOR_NAME` /
 * `WARREN_GIT_AUTHOR_EMAIL` is set. The run still commits as the default
 * identity, but the operator clearly meant to configure their own. An unset
 * pair is not a warning: the default is documented, and `warren doctor`
 * names the identity that applies.
 */
export function warnIfGitIdentityHalfSet(log: SpawnLogger, serverEnv: EnvLike): void {
	const identity = resolveAgentGitIdentity(serverEnv);
	if (identity.source !== "half-set") return;
	log.warn(
		{ event: "spawn.git_identity_half_set", name: identity.name, email: identity.email },
		"only one of WARREN_GIT_AUTHOR_NAME/WARREN_GIT_AUTHOR_EMAIL is set — agent commits use the default identity; set both or neither",
	);
}

/**
 * Canonical git identity for the agent's own commits (namphuongtran/warren#160).
 *
 * Per docs/CONSTITUTION.md Article VII ("Identity is consistent"), the
 * operator decides who an agent commit is authored by, never the model. The
 * operator sets `WARREN_GIT_AUTHOR_NAME` + `WARREN_GIT_AUTHOR_EMAIL` (both
 * halves or nothing). When the pair is absent or half-set, every run commits
 * as `AGENT_GIT_IDENTITY_DEFAULT`. Before this default existed, an unset
 * pair left the run with no identity at all: the agent's first `git commit`
 * failed with "Author identity unknown", and the agent made one up
 * (`warren <warren@localhost>` in one run, `Claude <noreply@anthropic.com>` in
 * the next).
 *
 * The dispatch path passes the resolved identity to every run as the four
 * `GIT_AUTHOR_*` / `GIT_COMMITTER_*` env vars (`src/runs/spawn/git-identity.ts`).
 * Git reads those ahead of any config, so a `git config user.name` inside the
 * sandbox cannot change the author. Warren never writes a gitconfig for it,
 * so a server that runs on the host leaves the operator's `~/.gitconfig`
 * alone.
 *
 * This identity is distinct from warren's bookkeeping bot in
 * `src/bot-identity.ts` (`warren <bot@warren.invalid>`), which authors the
 * reap-time `chore(warren)` commits. Two identities, two spellings, so an
 * auditor can tell agent work from bookkeeping by author alone. The default
 * sits under the RFC 2606 `.invalid` TLD for the same reason as the bot's: a
 * self-hosted default must attribute to nobody.
 */
export const AGENT_GIT_IDENTITY_DEFAULT = {
	name: "warren-agent",
	email: "agent@warren.invalid",
} as const;

/** Minimal env surface for identity resolution — injectable for tests. */
export type AgentIdentityEnv = Readonly<Record<string, string | undefined>>;

/**
 * Where the resolved identity came from. `half-set` means exactly one of the
 * two vars is non-blank: the configured half is ignored, the default applies,
 * and callers should warn, because the operator meant to configure one.
 */
export type AgentIdentitySource = "configured" | "default" | "half-set";

export interface ResolvedAgentIdentity {
	readonly name: string;
	readonly email: string;
	readonly source: AgentIdentitySource;
}

/**
 * Resolve the identity every agent commit uses: the operator's pair when both
 * halves are non-blank, else `AGENT_GIT_IDENTITY_DEFAULT`. A half-set pair is
 * never half-applied, so a typo cannot produce a hybrid spelling.
 */
export function resolveAgentGitIdentity(env: AgentIdentityEnv): ResolvedAgentIdentity {
	const name = env.WARREN_GIT_AUTHOR_NAME?.trim() ?? "";
	const email = env.WARREN_GIT_AUTHOR_EMAIL?.trim() ?? "";
	if (name !== "" && email !== "") return { name, email, source: "configured" };
	const source = name === "" && email === "" ? "default" : "half-set";
	return { ...AGENT_GIT_IDENTITY_DEFAULT, source };
}

/**
 * The four `GIT_AUTHOR_*` / `GIT_COMMITTER_*` env vars for the resolved agent
 * identity. Returned as a fresh object so callers can merge it without
 * sharing state.
 */
export function agentGitIdentityEnv(env: AgentIdentityEnv): Record<string, string> {
	const { name, email } = resolveAgentGitIdentity(env);
	return {
		GIT_AUTHOR_NAME: name,
		GIT_AUTHOR_EMAIL: email,
		GIT_COMMITTER_NAME: name,
		GIT_COMMITTER_EMAIL: email,
	};
}

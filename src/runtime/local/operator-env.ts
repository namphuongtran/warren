/**
 * The operator's extension of the sandbox env allowlist (namphuongtran/warren#56).
 *
 * `resolveEnvPassthrough` forwards only the model credentials each harness
 * needs. A project's own gate can need one more host credential, such as
 * `NODE_AUTH_TOKEN` for a private npm registry. `WARREN_AGENT_ENV_PASSTHROUGH`
 * names those extra host env vars, comma- or space-separated, and every run
 * gets them. The operator sets it on the server, never the repository, so a
 * repo cannot ask for a credential the operator did not choose to share.
 */

export const OPERATOR_ENV_PASSTHROUGH_VAR = "WARREN_AGENT_ENV_PASSTHROUGH";

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** The valid env names in `WARREN_AGENT_ENV_PASSTHROUGH`, deduplicated, in order. */
export function operatorEnvPassthrough(env: Record<string, string | undefined>): string[] {
	const raw = env[OPERATOR_ENV_PASSTHROUGH_VAR] ?? "";
	const names = raw.split(/[\s,]+/).filter((name) => ENV_NAME.test(name));
	return [...new Set(names)];
}

/** `base` plus the operator's names that `base` lacks. */
export function withOperatorEnvPassthrough(
	base: readonly string[],
	env: Record<string, string | undefined>,
): string[] {
	const out = [...base];
	for (const name of operatorEnvPassthrough(env)) {
		if (!out.includes(name)) out.push(name);
	}
	return out;
}

/**
 * Per-run wall-clock limit resolution (namphuongtran/warren#10).
 *
 * The turn monitor catches a silent model turn and the watchdog catches a
 * silent-but-busy run, but a run that keeps emitting events had no ceiling
 * on total wall-clock time. `maxDurationMinutes` is that ceiling. It rides
 * the same three-tier chain as the spend cap (./cost-cap.ts):
 *
 *   - per-dispatch override — `POST /runs` `maxDurationMinutes` or
 *                             `warren run --max-duration-minutes`.
 *   - per-agent limit       — `frontmatter.maxDurationMinutes`.
 *   - project default       — `maxDurationMinutes` on `.warren/config.yaml`,
 *                             applied only when the agent declares none.
 *
 * Dispatch folds the resolved value onto the agent frontmatter before
 * freezing `runs.rendered_agent_json`, so the bridge reads one limit from
 * the row (`resolveDurationLimitMs`). Absent means unlimited. A malformed
 * value fails OPEN, the same rule the spend cap follows: a typo must never
 * cancel every run at minute zero.
 */

import type { AgentDefinition } from "../registry/schema.ts";
import { coerceCostCap, frozenFrontmatter, resolveFrontmatterLimitOverride } from "./cost-cap.ts";

/** Frontmatter / config key carrying the per-run wall-clock limit. */
export const MAX_DURATION_MINUTES_KEY = "maxDurationMinutes";

const MS_PER_MINUTE = 60_000;

/**
 * Read the per-agent limit (minutes) from a frontmatter bag. Accepts numbers
 * and numeric strings; returns `null` ("no limit") for anything absent,
 * non-positive, or unparseable. The positive-number coercion is the spend
 * cap's, shared so both limits fail open identically.
 */
export function readMaxDurationMinutes(
	frontmatter: Readonly<Record<string, unknown>>,
): number | null {
	return coerceCostCap(frontmatter[MAX_DURATION_MINUTES_KEY]);
}

/**
 * Resolve the value to fold onto the agent frontmatter for one spawn, with
 * the spend cap's precedence (`resolveFrontmatterLimitOverride`): a
 * present-but-malformed agent value stays on the frozen row as evidence and
 * fails open at the bridge. Returns `undefined` when nothing should be folded.
 */
export function resolveDurationOverride(input: {
	readonly overrideMinutes?: number;
	readonly frontmatter: Readonly<Record<string, unknown>>;
	readonly projectDefaultMinutes?: number;
}): number | undefined {
	return resolveFrontmatterLimitOverride(
		input.frontmatter[MAX_DURATION_MINUTES_KEY],
		input.overrideMinutes,
		input.projectDefaultMinutes,
	);
}

/**
 * Resolve the chain for `agent` and fold the winner onto its frontmatter.
 * Returns the agent untouched when nothing folds; never mutates it.
 */
export function withDurationLimit(
	agent: AgentDefinition,
	sources: { readonly overrideMinutes?: number; readonly projectDefaultMinutes?: number },
): AgentDefinition {
	const minutes = resolveDurationOverride({ ...sources, frontmatter: agent.frontmatter });
	if (minutes === undefined) return agent;
	return { ...agent, frontmatter: { ...agent.frontmatter, [MAX_DURATION_MINUTES_KEY]: minutes } };
}

/**
 * The run's effective limit in milliseconds, read from its frozen
 * `runs.rendered_agent_json`. `null` means unlimited.
 */
export function resolveDurationLimitMs(renderedAgentJson: unknown): number | null {
	const frontmatter = frozenFrontmatter(renderedAgentJson);
	const minutes = frontmatter === null ? null : readMaxDurationMinutes(frontmatter);
	return minutes === null ? null : minutes * MS_PER_MINUTE;
}

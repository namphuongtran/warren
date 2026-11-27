/**
 * The run's context-window view (namphuongtran/warren#20): how full the
 * model's context window was at the run's newest usage reading, for the run
 * detail's Spend panel.
 *
 * The bridge records each reading in `run_context` as it streams
 * (`./stream/context-warning.ts`), with the window the adapter resolved at
 * that moment. This module only reads that row, one primary-key lookup, so
 * the view is right for a finished run and across a warren restart.
 */

import type { Repos } from "../db/repos/index.ts";

/** The overlay fields; both null while the run has no reading. */
export interface ContextWindowFields {
	readonly contextTokens: number | null;
	readonly contextWindowTokens: number | null;
}

/** The run's newest context reading as overlay fields. */
export async function currentContextWindow(
	repos: Repos,
	runId: string,
): Promise<ContextWindowFields> {
	const row = await repos.runContext.get(runId);
	if (row === undefined) return { contextTokens: null, contextWindowTokens: null };
	return { contextTokens: row.tokensUsed, contextWindowTokens: row.windowTokens };
}

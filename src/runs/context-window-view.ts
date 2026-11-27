/**
 * The run's context-window view (namphuongtran/warren#20): how full the
 * model's context window was at the run's newest usage reading, for the run
 * detail's Spend panel.
 *
 * The bridge raises `context.warning` from the same readings as they stream
 * (`./stream/context-warning.ts`). This module only reads: one query finds the
 * newest event of a type an adapter reads context from, and the adapter that
 * owns it turns it into tokens and a window. Reading the persisted events
 * keeps the view right for a finished run and across a warren restart.
 */

import type { Repos } from "../db/repos/index.ts";
import type { RunRow } from "../db/schema.ts";
import { contextEnvelopeTypes, observeContext } from "../runtime/adapters/index.ts";

/** The overlay fields; both null while the run has no reading. */
export interface ContextWindowFields {
	readonly contextTokens: number | null;
	readonly contextWindowTokens: number | null;
}

const NO_READING: ContextWindowFields = { contextTokens: null, contextWindowTokens: null };

/** The run's newest context reading as overlay fields. */
export async function currentContextWindow(
	repos: Repos,
	run: RunRow,
): Promise<ContextWindowFields> {
	const row = await repos.events.newestOfPayloadTypes(run.id, contextEnvelopeTypes());
	if (row === null) return NO_READING;
	const observation = observeContext(
		{
			kind: row.kind,
			stream: row.stream,
			...(row.origin !== null ? { origin: row.origin } : {}),
			payload: row.payloadJson,
		},
		run.model,
	);
	if (observation === null) return NO_READING;
	return { contextTokens: observation.tokensUsed, contextWindowTokens: observation.windowTokens };
}

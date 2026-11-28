/**
 * The needs-input view (namphuongtran/warren#25): which runs wait on an
 * operator's answer, for the runs list and the run page.
 *
 * A run needs input while its stored handoff is `blocked` and no
 * continuation an operator dispatched has answered it. An automatic
 * continuation, such as a CI fix on the run's PR, does not answer it.
 * Nothing is stored: the flag is derived on read from the handoff and the
 * parent/child run links, so the run lifecycle gains no state and both runs
 * stay immutable. One batched query finds the continuations, and only for
 * the blocked runs among `runs`, so a page with none pays nothing.
 */

import type { RunNeedsInputView } from "../core/wire.ts";
import type { Repos } from "../db/repos/index.ts";
import type { RunRow } from "../db/schema.ts";

const NO_INPUT_NEEDED: RunNeedsInputView = { needsInput: false, answeredByRunId: null };

function isBlocked(run: RunRow): boolean {
	return run.handoff?.state === "recorded" && run.handoff.handoff.status === "blocked";
}

/** Read the needs-input view for `runs`; the result looks one up by run id. */
export async function readNeedsInput(
	repos: Repos,
	runs: readonly RunRow[],
): Promise<(runId: string) => RunNeedsInputView> {
	const blocked = new Set(runs.filter(isBlocked).map((run) => run.id));
	const links = await repos.runs.listOperatorContinuationsOf([...blocked]);
	const answeredBy = new Map<string, string>();
	// Newest first: the first link per parent is its latest continuation.
	for (const link of links) {
		if (!answeredBy.has(link.parentRunId)) answeredBy.set(link.parentRunId, link.id);
	}
	return (runId) => {
		if (!blocked.has(runId)) return NO_INPUT_NEEDED;
		const answeredByRunId = answeredBy.get(runId) ?? null;
		return { needsInput: answeredByRunId === null, answeredByRunId };
	};
}

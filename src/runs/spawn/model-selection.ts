/**
 * Dispatch-time warning for a provider/model selection the run's harness
 * drops (namphuongtran/warren#7). The adapter names what it drops
 * (`ignoredModelSelection`). This module records that as a log line and a
 * system event. The bridge records the model the harness really ran
 * (`../stream/observed-model.ts`).
 */

import { type AcceptedRuntimeId, isKnownRuntimeId } from "../../core/wire.ts";
import { adapterFor } from "../../runtime/adapters/index.ts";
import type { SpawnLogger, SpawnRunInput } from "./types.ts";

/** Run event kind recording a dropped provider/model (system stream). */
export const MODEL_SELECTION_IGNORED_EVENT_KIND = "model_selection_ignored";

/**
 * The seq this warning is written at. The runtime numbers its own events
 * from 1, and the bridge resumes from the highest persisted seq, so a
 * pre-runtime row at `max + 1` would make the bridge skip the runtime's
 * first event: for claude-code that is the init envelope carrying the
 * observed model. Seq 0 sorts first and shadows nothing.
 */
const PRE_RUNTIME_SEQ = 0;

export interface IgnoredModelSelectionInput {
	readonly runId: string;
	readonly runtimeId: AcceptedRuntimeId;
	/** The resolved (declared) provider/model, after the override chain. */
	readonly selection: {
		readonly provider?: string | undefined;
		readonly model?: string | undefined;
	};
	readonly log: SpawnLogger;
}

/**
 * Warn when the run's harness will not use the resolved provider/model.
 * Call before `provider.create`, so the warning precedes every runtime
 * event. Best-effort: a failed append logs and never fails the dispatch.
 * A runtime id with no adapter (an operator-registered extra id) has no
 * answer to give and records nothing.
 */
export async function recordIgnoredModelSelection(
	deps: Pick<SpawnRunInput, "repos" | "now">,
	input: IgnoredModelSelectionInput,
): Promise<void> {
	if (!isKnownRuntimeId(input.runtimeId)) return;
	const { provider, model } = input.selection;
	const ignored = adapterFor(input.runtimeId).ignoredModelSelection?.({
		...(provider !== undefined ? { provider } : {}),
		...(model !== undefined ? { model } : {}),
	});
	if (ignored === undefined) return;
	const payload = { runtime: input.runtimeId, ...ignored };
	input.log.warn(payload, "harness ignores the resolved provider/model");
	try {
		await deps.repos.events.append({
			runId: input.runId,
			sandboxEventSeq: PRE_RUNTIME_SEQ,
			ts: (deps.now?.() ?? new Date()).toISOString(),
			kind: MODEL_SELECTION_IGNORED_EVENT_KIND,
			stream: "system",
			payload,
		});
	} catch (err) {
		input.log.warn(
			{ err: err instanceof Error ? err.message : String(err) },
			"failed to record the model_selection_ignored event",
		);
	}
}

/**
 * Dispatch-time warnings about the run's provider/model selection, each
 * recorded as a log line and a system event:
 *
 * - The run's harness drops the resolved provider/model
 *   (namphuongtran/warren#7). The adapter names what it drops
 *   (`ignoredModelSelection`). The bridge records the model the harness
 *   really ran (`../stream/observed-model.ts`).
 * - A model-only override dropped the inherited project provider
 *   (namphuongtran/warren#43, `resolveDispatchProvider`).
 */

import { type AcceptedRuntimeId, isKnownRuntimeId } from "../../core/wire.ts";
import { adapterFor } from "../../runtime/adapters/index.ts";
import type { SpawnLogger, SpawnRunInput } from "./types.ts";

/** Run event kind recording a dropped provider/model (system stream). */
export const MODEL_SELECTION_IGNORED_EVENT_KIND = "model_selection_ignored";

/** Run event kind recording a dropped project provider (system stream). */
export const PROJECT_PROVIDER_DROPPED_EVENT_KIND = "project_provider_dropped";

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
		/** The inherited project provider a model-only override dropped. */
		readonly droppedProjectProvider?: string | undefined;
	};
	readonly log: SpawnLogger;
}

/**
 * Record every provider/model warning for the run. Call before
 * `provider.create`, so the warnings precede every runtime event.
 * Best-effort: a failed append logs and never fails the dispatch.
 */
export async function recordModelSelectionWarnings(
	deps: Pick<SpawnRunInput, "repos" | "now">,
	input: IgnoredModelSelectionInput,
): Promise<void> {
	const { droppedProjectProvider, model } = input.selection;
	if (droppedProjectProvider !== undefined) {
		const payload = { droppedProvider: droppedProjectProvider, model };
		input.log.warn(payload, "dropped the project provider: the model override cannot use it");
		await appendWarning(deps, input, PROJECT_PROVIDER_DROPPED_EVENT_KIND, payload);
	}
	await recordIgnoredModelSelection(deps, input);
}

/**
 * Warn when the run's harness will not use the resolved provider/model.
 * A runtime id with no adapter (an operator-registered extra id) has no
 * answer to give and records nothing.
 */
async function recordIgnoredModelSelection(
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
	await appendWarning(deps, input, MODEL_SELECTION_IGNORED_EVENT_KIND, payload);
}

async function appendWarning(
	deps: Pick<SpawnRunInput, "repos" | "now">,
	input: IgnoredModelSelectionInput,
	kind: string,
	payload: Record<string, unknown>,
): Promise<void> {
	try {
		await deps.repos.events.append({
			runId: input.runId,
			sandboxEventSeq: PRE_RUNTIME_SEQ,
			ts: (deps.now?.() ?? new Date()).toISOString(),
			kind,
			stream: "system",
			payload,
		});
	} catch (err) {
		input.log.warn(
			{ err: err instanceof Error ? err.message : String(err) },
			`failed to record the ${kind} event`,
		);
	}
}

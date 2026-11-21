/**
 * The model a run actually used, read off the harness's own stream
 * (namphuongtran/warren#7).
 *
 * Dispatch freezes the DECLARED model onto `runs.model`, but a harness can
 * run something else: claude-code drops a non-anthropic provider's model and
 * falls back to the account default. claude-code names the model it resolved
 * in its first stream-json line (`{"type":"system","subtype":"init","model":…}`),
 * so the bridge overwrites the row with it and every surface that shows the
 * row's model shows the observed one. The declared value stays in
 * `rendered_agent_json` and the dispatch-context snapshot.
 *
 * Shape-sniffed like `extractClaudeUsage`: pi emits no such envelope, so its
 * runs keep the declared model. The shared envelope extractor refuses an
 * agent-printed line (`origin === "agent"`), so an agent cannot relabel its
 * own run.
 */

import { extractAgentEventEnvelope } from "../../core/event-envelope.ts";
import type { BridgeLogger, BridgeRunStreamInput, StreamEventView } from "./types.ts";

/** The model named by a harness init envelope, or null for any other event. */
export function readObservedModel(event: StreamEventView): string | null {
	const env = extractAgentEventEnvelope(event);
	if (env === null || env.type !== "system" || env.payload.subtype !== "init") return null;
	const model = env.payload.model;
	if (typeof model !== "string") return null;
	const trimmed = model.trim();
	return trimmed === "" ? null : trimmed;
}

/**
 * Record the observed model on the run row when `event` carries one.
 * Best-effort: a failed write logs and leaves the declared model in place,
 * because a labelling miss must never stop the event pump.
 */
export async function recordObservedModel(
	repos: BridgeRunStreamInput["repos"],
	runId: string,
	event: StreamEventView,
	logger: BridgeLogger | undefined,
): Promise<void> {
	const model = readObservedModel(event);
	if (model === null) return;
	try {
		await repos.runs.setModel(runId, model);
	} catch (err) {
		logger?.warn?.(
			{ runId, model, err: err instanceof Error ? err.message : String(err) },
			"failed to record the run's observed model; the declared model stays on the row",
		);
	}
}

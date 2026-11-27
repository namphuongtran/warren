/**
 * claude-code context-window reader (namphuongtran/warren#20).
 *
 * Every stream-json `assistant` line carries the request's usage, which the
 * parser keeps as one `assistant_usage` telemetry event on the system stream
 * (`./parsers/jsonl-claude.ts`):
 *
 *   {"type":"assistant_usage","message":{"id":"msg_…","model":"claude-haiku-5-5",
 *    "usage":{"input_tokens":2,"cache_creation_input_tokens":7794,
 *             "cache_read_input_tokens":12328,"output_tokens":1}}}
 *
 * A request sends the whole conversation, so input + both cache counts +
 * output is how much of the window the conversation holds after the turn.
 * The CLI writes one line per content block and repeats the request's usage
 * on each (`./parsers/__golden__/claude-code-v2.1.332-tool-use.jsonl`), so a
 * reading can arrive more than once. The event exists only to carry the
 * reading: the bridge reads it and never persists it
 * ({@link isClaudeContextOnlyEvent}), so the transcript stays free of one
 * usage row per request.
 *
 * The window comes from `./claude-context-windows.ts`. The API names a dated
 * snapshot id on each message and drops claude-code's `[1m]` suffix, so the
 * suffix is read off `runModel`, the model the run's row or its init envelope
 * names. The CLI's own `<synthetic>` messages use no tokens and name no Claude
 * model, so they read as no observation. Like the quota reader beside it, the
 * read refuses an agent-authored line.
 */

import { type EventEnvelopeInput, isAgentAuthoredEvent } from "../../core/event-envelope.ts";
import { claudeContextWindowTokens, selectsOneMillionWindow } from "./claude-context-windows.ts";
import type { ContextObservation } from "./types.ts";

type JsonObject = Record<string, unknown>;

/** The payload type of the parser's usage event. */
export const CLAUDE_USAGE_ENVELOPE_TYPE = "assistant_usage";

function asObject(value: unknown): JsonObject | null {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as JsonObject)
		: null;
}

function count(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

/** `message` of a trusted `assistant_usage` event, else `null`. */
function usageMessage(event: EventEnvelopeInput): JsonObject | null {
	if (isAgentAuthoredEvent(event)) return null;
	if (event.kind !== "telemetry" || event.stream !== "system") return null;
	const payload = asObject(event.payload);
	if (payload?.type !== CLAUDE_USAGE_ENVELOPE_TYPE) return null;
	return asObject(payload.message);
}

/** True for the parser's `assistant_usage` event, which only carries a context reading. */
export function isClaudeContextOnlyEvent(event: EventEnvelopeInput): boolean {
	return usageMessage(event) !== null;
}

/** Read one `assistant_usage` event into a context observation, else `null`. */
export function observeClaudeContext(
	event: EventEnvelopeInput,
	runModel?: string | null,
): ContextObservation | null {
	const message = usageMessage(event);
	const usage = asObject(message?.usage);
	if (message === null || usage === null || typeof message.model !== "string") return null;
	const model =
		typeof runModel === "string" && selectsOneMillionWindow(runModel) ? runModel : message.model;
	const windowTokens = claudeContextWindowTokens(model);
	const tokensUsed =
		count(usage.input_tokens) +
		count(usage.cache_creation_input_tokens) +
		count(usage.cache_read_input_tokens) +
		count(usage.output_tokens);
	if (windowTokens === null || tokensUsed === 0) return null;
	return { tokensUsed, windowTokens, model };
}

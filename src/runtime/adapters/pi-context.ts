/**
 * pi context-window reader (namphuongtran/warren#20).
 *
 * Every pi `turn_end` carries the turn's assistant message, which names the
 * model and the request's usage:
 *
 *   {"type":"turn_end","message":{"model":"claude-haiku-4-5",
 *    "usage":{"input":1684,"output":106,"cacheRead":0,"cacheWrite":0,"totalTokens":1790}}}
 *
 * (`./parsers/__golden__/pi-v0.78.1-anthropic-tools.canonical.jsonl`). The
 * usage is per request, not summed across the run, and a request sends the
 * whole conversation, so input + cache read + cache write + output is how much
 * of the window the conversation holds after the turn. pi reports that sum as
 * `totalTokens`.
 *
 * The stream does not carry the window size, so it comes from the table below.
 * A model it does not know reads as no observation, and the bridge stays quiet.
 */

import { type EventEnvelopeInput, extractAgentEventEnvelope } from "../../core/event-envelope.ts";
import type { ContextObservation } from "./types.ts";

type JsonObject = Record<string, unknown>;

/** The envelope types {@link observePiContext} reads. */
export const PI_CONTEXT_ENVELOPE_TYPES: readonly string[] = ["turn_end"];

function asObject(value: unknown): JsonObject | null {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as JsonObject)
		: null;
}

function count(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * Context window per model family, matched on the id after any `provider/`
 * routing prefix. First match wins.
 */
const PI_CONTEXT_WINDOWS: readonly { readonly pattern: RegExp; readonly tokens: number }[] = [
	{ pattern: /^claude-/, tokens: 200_000 },
];

/** The model's context window in tokens, or `null` when the table does not know it. */
function piContextWindowTokens(model: string): number | null {
	const id = model.slice(model.lastIndexOf("/") + 1).toLowerCase();
	return PI_CONTEXT_WINDOWS.find((entry) => entry.pattern.test(id))?.tokens ?? null;
}

/** Read a trusted `turn_end` into a context observation, else `null`. */
export function observePiContext(event: EventEnvelopeInput): ContextObservation | null {
	const envelope = extractAgentEventEnvelope(event);
	if (envelope === null || !PI_CONTEXT_ENVELOPE_TYPES.includes(envelope.type)) return null;
	const message = asObject(envelope.payload.message);
	const usage = asObject(message?.usage);
	const model = typeof message?.model === "string" ? message.model : null;
	if (usage === null || model === null) return null;
	const tokensUsed = count(usage.totalTokens);
	const windowTokens = piContextWindowTokens(model);
	if (tokensUsed === null || tokensUsed === 0 || windowTokens === null) return null;
	return { tokensUsed, windowTokens, model };
}

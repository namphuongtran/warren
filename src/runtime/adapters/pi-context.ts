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
 * `totalTokens`. The `turn_end` is persisted for its own sake (cost reads it),
 * so pi has no context-only event.
 *
 * The stream does not carry the window size. pi runs the same Claude models
 * claude-code does, so the window comes from the shared table in
 * `./claude-context-windows.ts`. A model it does not know, Claude or not, reads
 * as no observation, and the bridge stays quiet.
 */

import { type EventEnvelopeInput, extractAgentEventEnvelope } from "../../core/event-envelope.ts";
import { claudeContextWindowTokens } from "./claude-context-windows.ts";
import type { ContextObservation } from "./types.ts";

type JsonObject = Record<string, unknown>;

function asObject(value: unknown): JsonObject | null {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as JsonObject)
		: null;
}

function count(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/** Read a trusted `turn_end` into a context observation, else `null`. */
export function observePiContext(event: EventEnvelopeInput): ContextObservation | null {
	const envelope = extractAgentEventEnvelope(event);
	if (envelope === null || envelope.type !== "turn_end") return null;
	const message = asObject(envelope.payload.message);
	const usage = asObject(message?.usage);
	const model = typeof message?.model === "string" ? message.model : null;
	if (usage === null || model === null) return null;
	const tokensUsed = count(usage.totalTokens);
	const windowTokens = claudeContextWindowTokens(model);
	if (tokensUsed === null || tokensUsed === 0 || windowTokens === null) return null;
	return { tokensUsed, windowTokens, model };
}

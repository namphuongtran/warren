/**
 * claude-code context-window reader (namphuongtran/warren#20).
 *
 * Every stream-json `assistant` line carries the request's usage, which the
 * parser keeps as one `assistant_usage` telemetry event on the system stream
 * (`./parsers/jsonl-claude.ts`):
 *
 *   {"type":"assistant_usage","message":{"id":"msg_…","model":"claude-sonnet-5-5",
 *    "usage":{"input_tokens":4,"cache_creation_input_tokens":1200,
 *             "cache_read_input_tokens":150000,"output_tokens":96}}}
 *
 * A request sends the whole conversation, so input + both cache counts +
 * output is how much of the window the conversation holds after the turn.
 *
 * The window is the CLI's: 200k tokens for a Claude model, 1M when the model is
 * selected with the `[1m]` suffix. The API names the bare model id on each
 * message, so the suffix is read off `runModel`, the model the run's row or its
 * init envelope names. The CLI's own `<synthetic>` messages use no tokens and
 * name no Claude model, so they read as no observation. Like the quota reader
 * beside it, the read refuses an agent-authored line.
 */

import { type EventEnvelopeInput, isAgentAuthoredEvent } from "../../core/event-envelope.ts";
import type { ContextObservation } from "./types.ts";

type JsonObject = Record<string, unknown>;

/** The payload types {@link observeClaudeContext} reads. */
export const CLAUDE_CONTEXT_ENVELOPE_TYPES: readonly string[] = ["assistant_usage"];

const ONE_MILLION_SUFFIX = /\[1m\]$/i;
const DEFAULT_WINDOW_TOKENS = 200_000;
const ONE_MILLION_WINDOW_TOKENS = 1_000_000;

function asObject(value: unknown): JsonObject | null {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as JsonObject)
		: null;
}

function count(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

/** The CLI's context window for `model`, or `null` for a model that is not Claude's. */
function claudeContextWindowTokens(model: string): number | null {
	if (ONE_MILLION_SUFFIX.test(model)) return ONE_MILLION_WINDOW_TOKENS;
	return /^claude-/i.test(model) ? DEFAULT_WINDOW_TOKENS : null;
}

/** `message` of a trusted `assistant_usage` event, else `null`. */
function usageMessage(event: EventEnvelopeInput): JsonObject | null {
	if (isAgentAuthoredEvent(event)) return null;
	if (event.kind !== "telemetry" || event.stream !== "system") return null;
	const payload = asObject(event.payload);
	if (typeof payload?.type !== "string") return null;
	if (!CLAUDE_CONTEXT_ENVELOPE_TYPES.includes(payload.type)) return null;
	return asObject(payload.message);
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
		typeof runModel === "string" && ONE_MILLION_SUFFIX.test(runModel) ? runModel : message.model;
	const windowTokens = claudeContextWindowTokens(model);
	const tokensUsed =
		count(usage.input_tokens) +
		count(usage.cache_creation_input_tokens) +
		count(usage.cache_read_input_tokens) +
		count(usage.output_tokens);
	if (windowTokens === null || tokensUsed === 0) return null;
	return { tokensUsed, windowTokens, model };
}

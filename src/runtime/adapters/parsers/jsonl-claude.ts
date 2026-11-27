/**
 * Claude Code stream-json parser.
 *
 * Source-lifted verbatim from burrow's `src/runtime/parsers/jsonl-claude.ts`
 * (warren-7933, plan pl-3007).
 *
 * Claude Code emits one JSON object per line in the shape:
 *   {"type":"system","subtype":"init", ...}
 *   {"type":"assistant","message":{"role":"assistant","content":[...]}}
 *   {"type":"user","message":{"role":"user","content":[{"type":"tool_result", ...}]}}
 *   {"type":"result","subtype":"success", "is_error":false, "result":"...", "usage":{...}}
 *   {"type":"rate_limit_event","rate_limit_info":{...}}
 *
 * We map these to the stable burrow event taxonomy (SPEC §14.1):
 *   - `assistant` text  → `text`
 *   - `assistant` thinking → `thinking` (empty-text blocks dropped — burrow-5d64)
 *   - `assistant` tool_use → `tool_use` (one per content block)
 *   - `assistant` message.usage → one `telemetry` `assistant_usage` (system
 *     stream) after the blocks (namphuongtran/warren#20)
 *   - `user` tool_result → `tool_result`
 *   - `system` → `state_change`
 *   - `result` → `state_change`
 *   - `rate_limit_event` → `telemetry` (system stream — burrow-5d64)
 *   - everything else → `text` carrying the raw envelope
 *
 * A single Claude Code line can produce multiple events when the assistant
 * message has multiple content blocks (e.g. text + tool_use), so the parser
 * returns an array and lets the run loop persist them in order.
 */

import type { AdapterRuntimeEvent as RuntimeEvent } from "../types.ts";

interface ClaudeContentBlock {
	type?: string;
	text?: string;
	thinking?: string;
	[key: string]: unknown;
}

interface ClaudeMessage {
	id?: string;
	role?: string;
	model?: string;
	content?: ClaudeContentBlock[];
	usage?: unknown;
}

interface ClaudeEnvelope {
	type?: string;
	subtype?: string;
	message?: ClaudeMessage;
	[key: string]: unknown;
}

export function parseJsonlClaude(line: string): RuntimeEvent[] {
	const trimmed = line.trim();
	if (trimmed.length === 0) return [];

	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed);
	} catch {
		return [
			{
				kind: "text",
				stream: "stdout",
				payload: { text: line, parseError: "invalid JSON" },
			},
		];
	}

	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		return [{ kind: "text", stream: "stdout", payload: { text: line } }];
	}

	const env = parsed as ClaudeEnvelope;

	const systemEvent = mapSystemEnvelope(env);
	if (systemEvent !== null) return [systemEvent];

	if (env.type === "assistant" && env.message?.content) {
		return mapAssistantEnvelope(env, env.message.content);
	}

	if (env.type === "user" && env.message?.content) {
		return env.message.content
			.filter((block) => block.type === "tool_result")
			.map((block) => ({
				kind: "tool_result" as const,
				stream: "stdout" as const,
				payload: block,
			}));
	}

	return [{ kind: "text", stream: "stdout", payload: env }];
}

/**
 * Lifecycle / telemetry envelopes that map one-to-one onto a single event.
 * Extracted from `parseJsonlClaude` for the cognitive-complexity budget
 * (warren-7933) — the mapping itself is verbatim burrow's.
 */
function mapSystemEnvelope(env: ClaudeEnvelope): RuntimeEvent | null {
	if (env.type === "system") {
		return { kind: "state_change", stream: "system", payload: env };
	}
	if (env.type === "result") {
		return { kind: "state_change", stream: "system", payload: env };
	}
	if (env.type === "rate_limit_event") {
		return { kind: "telemetry", stream: "system", payload: env };
	}
	return null;
}

/** One event per content block, then the line's usage reading when it has one. */
function mapAssistantEnvelope(
	env: ClaudeEnvelope,
	content: readonly ClaudeContentBlock[],
): RuntimeEvent[] {
	const events: RuntimeEvent[] = [];
	for (const block of content) {
		const ev = mapAssistantBlock(block, env);
		if (ev !== null) events.push(ev);
	}
	const usage = mapAssistantUsage(env);
	if (usage !== null) events.push(usage);
	return events;
}

/**
 * The request usage an `assistant` line carries, as one `assistant_usage`
 * telemetry event (namphuongtran/warren#20). The block mapping above drops it,
 * and it is the only mid-run reading of how full the context window is. The
 * event exists only to carry that reading: the bridge reads it and never
 * persists it. The payload keeps claude's own `message.{id,model,usage}` field
 * names and drops the content the block events already carry. A sub-agent's
 * line (non-null `parent_tool_use_id`) measures the sub-agent's context, so it
 * emits none.
 */
function mapAssistantUsage(env: ClaudeEnvelope): RuntimeEvent | null {
	const message = env.message;
	if (message?.usage === undefined || message.usage === null) return null;
	if (typeof env.parent_tool_use_id === "string") return null;
	return {
		kind: "telemetry",
		stream: "system",
		payload: {
			type: "assistant_usage",
			message: { id: message.id, model: message.model, usage: message.usage },
		},
	};
}

function mapAssistantBlock(
	block: ClaudeContentBlock,
	envelope: ClaudeEnvelope,
): RuntimeEvent | null {
	if (block.type === "text") {
		return { kind: "text", stream: "stdout", payload: { text: block.text ?? "" } };
	}
	if (block.type === "thinking") {
		// claude-code occasionally emits an empty-text thinking block right
		// before its first tool call (burrow-5d64) — drop instead of forwarding
		// noise to consumers.
		const text = block.thinking ?? "";
		if (text.length === 0) return null;
		return { kind: "thinking", stream: "stdout", payload: { text } };
	}
	if (block.type === "tool_use") {
		return { kind: "tool_use", stream: "stdout", payload: block };
	}
	// Unknown block kinds still surface — better to record them than drop.
	return {
		kind: "text",
		stream: "stdout",
		payload: { block, envelopeType: envelope.type },
	};
}

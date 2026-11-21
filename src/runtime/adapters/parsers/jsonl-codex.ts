/**
 * Codex CLI `exec --json` parser (namphuongtran/warren#17).
 *
 * `codex exec --json` prints one `ThreadEvent` per line (codex-rs
 * `exec/src/exec_events.rs`, 0.171.0):
 *
 *   {"type":"thread.started","thread_id":"…"}
 *   {"type":"turn.started"}
 *   {"type":"item.started"|"item.updated"|"item.completed","item":{"id":"…","type":"…",…}}
 *   {"type":"turn.completed","usage":{"input_tokens":N,"cached_input_tokens":N,"output_tokens":N,…}}
 *   {"type":"turn.failed","error":{"message":"…"}}
 *   {"type":"error","message":"…"}
 *
 * Mapping onto the stable taxonomy (`AdapterEventKind`):
 *
 *   - `thread.started` / `turn.started` → `state_change` (system), verbatim.
 *   - `agent_message` (completed) → `text`; `reasoning` (completed) → `thinking`.
 *   - `command_execution` and `mcp_tool_call` open as `tool_use` on
 *     `item.started` and close as `tool_result` on `item.completed`.
 *     `file_change` and `web_search` arrive only completed, so one line yields
 *     the `tool_use` + `tool_result` pair. Tool payloads use the Anthropic
 *     content-block field names (`id`, `name`, `input`, `tool_use_id`,
 *     `is_error`, `content`) that the UI and the tool/file shape readers
 *     already read, as pi's rows do.
 *   - `todo_list` and in-progress partials → `telemetry` (system).
 *   - a non-fatal `error` item → `state_change` typed `codex.item_error`.
 *   - `turn.completed` / `turn.failed` → the shared terminal `result`
 *     envelope (`state_change`/system), the one claude-code emits. Usage
 *     accounting, the spend cap, terminal detection (local, Docker, and the
 *     K8s in-pod entrypoint), and the provider-error net already read that
 *     envelope, so none of them grow a Codex branch.
 *
 * `codex exec` runs one turn per spawn, so one `result` carries the run's
 * whole usage, which fits the cumulative `assign` fold of the `result`
 * usage shape (`src/core/usage-shape.ts`).
 */

import { codexCostUsd } from "../codex-pricing.ts";
import type { AdapterRuntimeEvent as RuntimeEvent } from "../types.ts";

/** What the parser needs from the run: the model to price, the provider to name. */
export interface CodexParseContext {
	readonly model?: string;
	readonly provider?: string;
}

/** Coarse error class, recorded on error envelopes for operators and logs. */
export type CodexErrorClass = "auth" | "rate_limit" | "context_overflow" | "other";

type Json = Record<string, unknown>;

const AUTH_ERROR =
	/\b40[13]\b|unauthori[sz]ed|api[-_ ]?key|not logged in|log ?in again|authenticat|token (has )?(expired|been revoked)/i;
const RATE_LIMIT_ERROR = /\b429\b|rate[ -]?limit|too many requests|usage limit|quota/i;
const CONTEXT_OVERFLOW_ERROR =
	/context[ _-]?(window|length)|context_length_exceeded|maximum context|ran out of room/i;

/** Classify a Codex error message. Auth wins over rate limit wins over context. */
export function classifyCodexError(message: string): CodexErrorClass {
	if (AUTH_ERROR.test(message)) return "auth";
	if (RATE_LIMIT_ERROR.test(message)) return "rate_limit";
	if (CONTEXT_OVERFLOW_ERROR.test(message)) return "context_overflow";
	return "other";
}

export function parseJsonlCodex(line: string, ctx: CodexParseContext = {}): RuntimeEvent[] {
	const trimmed = line.trim();
	if (trimmed.length === 0) return [];
	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed);
	} catch {
		return [
			{ kind: "text", stream: "stdout", payload: { text: line, parseError: "invalid JSON" } },
		];
	}
	const env = asRecord(parsed);
	if (env === null) return [{ kind: "text", stream: "stdout", payload: { text: line } }];

	switch (env.type) {
		case "thread.started":
		case "turn.started":
			return [system(env)];
		case "turn.completed":
			return [system(turnCompleted(env, ctx))];
		case "turn.failed":
			return [system(turnFailed(env, ctx))];
		case "error": {
			const message = str(env.message) ?? "";
			return [system({ ...env, error_class: classifyCodexError(message) })];
		}
		case "item.started":
		case "item.updated":
		case "item.completed":
			return mapItem(env);
		default:
			// Unknown envelopes still surface: better recorded than dropped.
			return [{ kind: "text", stream: "stdout", payload: env }];
	}
}

/* ------------------------------------------------------------------------ */
/* Turn terminals → the shared `result` envelope                             */
/* ------------------------------------------------------------------------ */

function turnCompleted(env: Json, ctx: CodexParseContext): Json {
	const raw = asRecord(env.usage) ?? {};
	const inputTokens = num(raw.input_tokens);
	const cachedInputTokens = Math.min(num(raw.cached_input_tokens), inputTokens);
	const outputTokens = num(raw.output_tokens);
	const cost = codexCostUsd(ctx.model, { inputTokens, cachedInputTokens, outputTokens });
	return {
		type: "result",
		subtype: "success",
		is_error: false,
		// A success turn clears an earlier error in the provider-error fold.
		stopReason: "end_turn",
		...identity(ctx),
		// Claude's field names: `input_tokens` excludes the cached share there.
		usage: {
			input_tokens: inputTokens - cachedInputTokens,
			cache_read_input_tokens: cachedInputTokens,
			output_tokens: outputTokens,
		},
		...(cost !== null
			? { total_cost_usd: cost }
			: { cost_unpriced_reason: unpricedReason(ctx.model) }),
		codex: env,
	};
}

function turnFailed(env: Json, ctx: CodexParseContext): Json {
	const message = str(asRecord(env.error)?.message) ?? "codex turn failed";
	return {
		type: "result",
		subtype: "error",
		is_error: true,
		stopReason: "error",
		errorMessage: message,
		error_class: classifyCodexError(message),
		...identity(ctx),
		codex: env,
	};
}

function identity(ctx: CodexParseContext): Json {
	return {
		model: ctx.model ?? null,
		...(ctx.provider !== undefined ? { provider: ctx.provider } : {}),
	};
}

function unpricedReason(model: string | undefined): string {
	return model === undefined
		? "no model was pinned for this run, so warren cannot price its tokens"
		: `warren has no price for model ${model}; add it to src/runtime/adapters/codex-pricing.ts`;
}

/* ------------------------------------------------------------------------ */
/* Items                                                                     */
/* ------------------------------------------------------------------------ */

function mapItem(env: Json): RuntimeEvent[] {
	const item = asRecord(env.item);
	if (item === null) return [telemetry(env)];
	const completed = env.type === "item.completed";
	switch (item.type) {
		case "agent_message":
			return completed ? [content("text", item)] : [telemetry(env)];
		case "reasoning":
			return completed ? reasoning(item) : [telemetry(env)];
		case "command_execution":
		case "mcp_tool_call":
			return pairedTool(env, item);
		case "file_change":
		case "web_search":
			return completed ? [toolUse(item), toolResult(item)] : [telemetry(env)];
		case "error": {
			const message = str(item.message) ?? "";
			return [
				system({
					type: "codex.item_error",
					id: item.id,
					message,
					error_class: classifyCodexError(message),
				}),
			];
		}
		default:
			return [telemetry(env)];
	}
}

/** A tool Codex opens on `item.started` and closes on `item.completed`. */
function pairedTool(env: Json, item: Json): RuntimeEvent[] {
	if (env.type === "item.started") return [toolUse(item)];
	if (env.type === "item.completed") return [toolResult(item)];
	return [telemetry(env)];
}

function content(kind: "text", item: Json): RuntimeEvent {
	return { kind, stream: "stdout", payload: { text: str(item.text) ?? "" } };
}

function reasoning(item: Json): RuntimeEvent[] {
	const text = str(item.text) ?? "";
	return text.length === 0 ? [] : [{ kind: "thinking", stream: "stdout", payload: { text } }];
}

function toolName(item: Json): string {
	switch (item.type) {
		case "command_execution":
			return "shell";
		case "file_change":
			return "apply_patch";
		case "mcp_tool_call":
			return `mcp__${str(item.server) ?? "unknown"}__${str(item.tool) ?? "unknown"}`;
		default:
			return str(item.type) ?? "unknown";
	}
}

function toolInput(item: Json): unknown {
	switch (item.type) {
		case "command_execution":
			return { command: item.command };
		case "file_change":
			return { changes: item.changes };
		case "mcp_tool_call":
			return item.arguments ?? null;
		case "web_search":
			return { query: item.query };
		default:
			return null;
	}
}

function toolUse(item: Json): RuntimeEvent {
	return {
		kind: "tool_use",
		stream: "stdout",
		payload: { type: "tool_use", id: item.id, name: toolName(item), input: toolInput(item) },
	};
}

function toolResult(item: Json): RuntimeEvent {
	const exitCode = typeof item.exit_code === "number" ? item.exit_code : undefined;
	const failed = item.status === "failed" || item.status === "declined";
	return {
		kind: "tool_result",
		stream: "stdout",
		payload: {
			type: "tool_result",
			tool_use_id: item.id,
			name: toolName(item),
			is_error: failed || (exitCode !== undefined && exitCode !== 0),
			content: toolResultContent(item),
			...(exitCode !== undefined ? { exit_code: exitCode } : {}),
			...(typeof item.status === "string" ? { status: item.status } : {}),
		},
	};
}

function toolResultContent(item: Json): unknown {
	switch (item.type) {
		case "command_execution":
			return item.aggregated_output ?? "";
		case "file_change":
			return fileChangeSummary(item.changes);
		case "mcp_tool_call":
			return str(asRecord(item.error)?.message) ?? asRecord(item.result)?.content ?? null;
		default:
			return item.results ?? null;
	}
}

function fileChangeSummary(changes: unknown): string {
	if (!Array.isArray(changes)) return "";
	return changes
		.map((change) => {
			const c = asRecord(change);
			return `${str(c?.kind) ?? "?"} ${str(c?.path) ?? "?"}`;
		})
		.join("\n");
}

/* ------------------------------------------------------------------------ */
/* Small helpers                                                             */
/* ------------------------------------------------------------------------ */

function system(payload: Json): RuntimeEvent {
	return { kind: "state_change", stream: "system", payload };
}

function telemetry(payload: Json): RuntimeEvent {
	return { kind: "telemetry", stream: "system", payload };
}

function asRecord(value: unknown): Json | null {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Json)
		: null;
}

function str(value: unknown): string | null {
	return typeof value === "string" ? value : null;
}

function num(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

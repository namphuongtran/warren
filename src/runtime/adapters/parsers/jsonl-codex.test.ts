import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseJsonlCodex } from "./jsonl-codex.ts";

const GOLDEN_DIR = join(import.meta.dir, "__golden__");

function one(line: unknown, ctx?: Parameters<typeof parseJsonlCodex>[1]) {
	const events = parseJsonlCodex(JSON.stringify(line), ctx);
	expect(events).toHaveLength(1);
	const [event] = events;
	if (event === undefined) throw new Error("no event");
	return event;
}

describe("parseJsonlCodex", () => {
	test("blank lines yield nothing and malformed lines degrade to text", () => {
		expect(parseJsonlCodex("  ")).toEqual([]);
		expect(parseJsonlCodex("{ nope")).toEqual([
			{ kind: "text", stream: "stdout", payload: { text: "{ nope", parseError: "invalid JSON" } },
		]);
		expect(parseJsonlCodex("[1]")).toEqual([
			{ kind: "text", stream: "stdout", payload: { text: "[1]" } },
		]);
	});

	test("thread and turn lifecycle envelopes ride state_change on the system stream", () => {
		const started = one({ type: "thread.started", thread_id: "t-1" });
		expect(started).toEqual({
			kind: "state_change",
			stream: "system",
			payload: { type: "thread.started", thread_id: "t-1" },
		});
		expect(one({ type: "turn.started" }).kind).toBe("state_change");
	});

	test("a completed agent message is text and a completed reasoning item is thinking", () => {
		expect(
			one({ type: "item.completed", item: { id: "i0", type: "agent_message", text: "Done." } }),
		).toEqual({ kind: "text", stream: "stdout", payload: { text: "Done." } });
		expect(
			one({ type: "item.completed", item: { id: "i1", type: "reasoning", text: "Plan it." } }),
		).toEqual({ kind: "thinking", stream: "stdout", payload: { text: "Plan it." } });
		expect(
			parseJsonlCodex(
				JSON.stringify({ type: "item.completed", item: { id: "i2", type: "reasoning", text: "" } }),
			),
		).toEqual([]);
	});

	test("a shell command opens as tool_use and closes as a tool_result carrying the exit code", () => {
		const use = one({
			type: "item.started",
			item: {
				id: "item_1",
				type: "command_execution",
				command: "bash -lc ls",
				aggregated_output: "",
				exit_code: null,
				status: "in_progress",
			},
		});
		expect(use.kind).toBe("tool_use");
		expect(use.payload).toMatchObject({
			type: "tool_use",
			id: "item_1",
			name: "shell",
			input: { command: "bash -lc ls" },
		});

		const result = one({
			type: "item.completed",
			item: {
				id: "item_1",
				type: "command_execution",
				command: "bash -lc ls",
				aggregated_output: "a.txt\n",
				exit_code: 2,
				status: "failed",
			},
		});
		expect(result.kind).toBe("tool_result");
		expect(result.payload).toMatchObject({
			type: "tool_result",
			tool_use_id: "item_1",
			name: "shell",
			is_error: true,
			exit_code: 2,
			content: "a.txt\n",
		});
	});

	test("a file change, emitted only on completion, becomes a tool_use + tool_result pair", () => {
		const events = parseJsonlCodex(
			JSON.stringify({
				type: "item.completed",
				item: {
					id: "item_3",
					type: "file_change",
					changes: [{ path: "/workspace/notes.md", kind: "add" }],
					status: "completed",
				},
			}),
		);
		expect(events.map((e) => e.kind)).toEqual(["tool_use", "tool_result"]);
		expect(events[0]?.payload).toMatchObject({
			name: "apply_patch",
			input: { changes: [{ path: "/workspace/notes.md", kind: "add" }] },
		});
		expect(events[1]?.payload).toMatchObject({ tool_use_id: "item_3", is_error: false });
	});

	test("an MCP call is named mcp__<server>__<tool> and its error flags the result", () => {
		const use = one({
			type: "item.started",
			item: {
				id: "m1",
				type: "mcp_tool_call",
				server: "docs",
				tool: "search",
				arguments: { q: "x" },
				result: null,
				error: null,
				status: "in_progress",
			},
		});
		expect(use.payload).toMatchObject({ name: "mcp__docs__search", input: { q: "x" } });
		const result = one({
			type: "item.completed",
			item: {
				id: "m1",
				type: "mcp_tool_call",
				server: "docs",
				tool: "search",
				arguments: { q: "x" },
				result: null,
				error: { message: "server down" },
				status: "failed",
			},
		});
		expect(result.payload).toMatchObject({ is_error: true, content: "server down" });
	});

	test("todo list updates are telemetry, never content", () => {
		const event = one({
			type: "item.updated",
			item: { id: "t", type: "todo_list", items: [{ text: "a", completed: false }] },
		});
		expect(event.kind).toBe("telemetry");
		expect(event.stream).toBe("system");
	});

	test("turn.completed normalizes onto the shared terminal result envelope with priced usage", () => {
		const event = one(
			{
				type: "turn.completed",
				usage: {
					input_tokens: 1_000_000,
					cached_input_tokens: 400_000,
					output_tokens: 100_000,
					reasoning_output_tokens: 20_000,
				},
			},
			{ model: "gpt-5.3-codex" },
		);
		expect(event.kind).toBe("state_change");
		expect(event.stream).toBe("system");
		// 600k uncached at $1.75/M + 400k cached at $0.175/M + 100k out at $14/M.
		expect(event.payload).toMatchObject({
			type: "result",
			subtype: "success",
			is_error: false,
			stopReason: "end_turn",
			model: "gpt-5.3-codex",
			usage: {
				input_tokens: 600_000,
				cache_read_input_tokens: 400_000,
				output_tokens: 100_000,
			},
		});
		const cost = (event.payload as { total_cost_usd: number }).total_cost_usd;
		expect(cost).toBeCloseTo(1.05 + 0.07 + 1.4, 10);
	});

	test("turn.completed for an unpriced model keeps tokens and says why it carries no cost", () => {
		const events = parseJsonlCodex(
			JSON.stringify({
				type: "turn.completed",
				usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5 },
			}),
			{ model: "gpt-9-imaginary" },
		);
		expect(events).toHaveLength(1);
		const payload = events[0]?.payload as Record<string, unknown>;
		expect(payload.type).toBe("result");
		expect(payload.total_cost_usd).toBeUndefined();
		expect(payload.cost_unpriced_reason).toContain("gpt-9-imaginary");
	});

	test("turn.failed is a failed terminal result carrying the provider error and its class", () => {
		const event = one(
			{
				type: "turn.failed",
				error: { message: "exceeded retry limit, last status: 429 Too Many Requests" },
			},
			{ model: "gpt-5.3-codex", provider: "openai" },
		);
		expect(event.payload).toMatchObject({
			type: "result",
			subtype: "error",
			is_error: true,
			stopReason: "error",
			errorMessage: "exceeded retry limit, last status: 429 Too Many Requests",
			provider: "openai",
			model: "gpt-5.3-codex",
			error_class: "rate_limit",
		});
	});

	test("error classes cover auth, rate limit, and context overflow", () => {
		const classOf = (message: string): unknown =>
			(one({ type: "error", message }).payload as Record<string, unknown>).error_class;
		expect(classOf("unexpected status 401 Unauthorized: Incorrect API key provided")).toBe("auth");
		expect(classOf("You've hit your usage limit. Try again later.")).toBe("rate_limit");
		expect(
			classOf("Codex ran out of room in the model's context window. Start a new thread."),
		).toBe("context_overflow");
		expect(classOf("stream disconnected before completion")).toBe("other");
	});

	test("a stream error is a non-terminal state_change, so a later success still wins", () => {
		const event = one({ type: "error", message: "Reconnecting... 1/5" });
		expect(event.kind).toBe("state_change");
		expect((event.payload as Record<string, unknown>).type).toBe("error");
		expect((event.payload as Record<string, unknown>).stopReason).toBeUndefined();
	});
});

/**
 * Golden traces: each fixture line runs through the parser and the result
 * is compared with the checked-in canonical file. Re-bless after an
 * intentional mapping change with
 * `WARREN_UPDATE_CODEX_GOLDEN=1 bun test src/runtime/adapters/parsers/jsonl-codex.test.ts`.
 */
describe("parseJsonlCodex golden traces", () => {
	for (const name of ["codex-v0.171.0-tools", "codex-v0.171.0-auth-failure"]) {
		test(`${name} maps to its canonical event stream`, () => {
			const input = readFileSync(join(GOLDEN_DIR, `${name}.jsonl`), "utf8");
			const ctx = { model: "gpt-5.3-codex", provider: "openai" };
			const actual = input
				.split("\n")
				.flatMap((line) => parseJsonlCodex(line, ctx))
				.map((event) => JSON.stringify(event))
				.join("\n");
			const canonicalPath = join(GOLDEN_DIR, `${name}.canonical.jsonl`);
			if (process.env.WARREN_UPDATE_CODEX_GOLDEN === "1") {
				writeFileSync(canonicalPath, `${actual}\n`);
			}
			expect(`${actual}\n`).toBe(readFileSync(canonicalPath, "utf8"));
		});
	}
});

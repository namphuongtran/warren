import { describe, expect, test } from "bun:test";
import { parseJsonlClaude } from "./jsonl-claude.ts";

describe("parseJsonlClaude", () => {
	test("empty / whitespace lines yield no events", () => {
		expect(parseJsonlClaude("")).toEqual([]);
		expect(parseJsonlClaude("   ")).toEqual([]);
	});

	test("invalid JSON falls back to a text event with parseError", () => {
		const events = parseJsonlClaude("{ not json");
		expect(events).toHaveLength(1);
		expect(events[0]?.kind).toBe("text");
		expect(events[0]?.payload).toMatchObject({ parseError: "invalid JSON" });
	});

	test("system envelope becomes a state_change on the system stream", () => {
		const line = JSON.stringify({
			type: "system",
			subtype: "init",
			session_id: "abc",
			model: "claude-sonnet-4-6",
		});
		const events = parseJsonlClaude(line);
		expect(events).toHaveLength(1);
		expect(events[0]?.kind).toBe("state_change");
		expect(events[0]?.stream).toBe("system");
	});

	test("assistant text + tool_use blocks expand to one event per block", () => {
		const line = JSON.stringify({
			type: "assistant",
			message: {
				role: "assistant",
				content: [
					{ type: "text", text: "hello" },
					{ type: "tool_use", id: "tu1", name: "Bash", input: { command: "ls" } },
					{ type: "thinking", thinking: "reasoning..." },
				],
			},
		});
		const events = parseJsonlClaude(line);
		expect(events.map((e) => e.kind)).toEqual(["text", "tool_use", "thinking"]);
		expect(events[0]?.payload).toEqual({ text: "hello" });
		expect(events[2]?.payload).toEqual({ text: "reasoning..." });
	});

	test("user tool_result blocks emit tool_result events; other user content is dropped", () => {
		const line = JSON.stringify({
			type: "user",
			message: {
				role: "user",
				content: [
					{ type: "text", text: "user prompt" },
					{ type: "tool_result", tool_use_id: "tu1", content: "stdout" },
				],
			},
		});
		const events = parseJsonlClaude(line);
		expect(events).toHaveLength(1);
		expect(events[0]?.kind).toBe("tool_result");
	});

	test("result envelope becomes a state_change on the system stream", () => {
		const line = JSON.stringify({
			type: "result",
			subtype: "success",
			is_error: false,
			result: "done",
		});
		const events = parseJsonlClaude(line);
		expect(events).toHaveLength(1);
		expect(events[0]?.kind).toBe("state_change");
		expect(events[0]?.stream).toBe("system");
	});

	test("rate_limit_event envelope becomes a telemetry event on the system stream", () => {
		const line = JSON.stringify({
			type: "rate_limit_event",
			rate_limit_info: {
				type: "anthropic_session",
				resets_at: "2026-05-08T20:00:00Z",
			},
		});
		const events = parseJsonlClaude(line);
		expect(events).toHaveLength(1);
		expect(events[0]?.kind).toBe("telemetry");
		expect(events[0]?.stream).toBe("system");
		expect(events[0]?.payload).toMatchObject({ type: "rate_limit_event" });
	});

	test("empty-text thinking blocks are dropped; non-empty siblings still emit", () => {
		const line = JSON.stringify({
			type: "assistant",
			message: {
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "" },
					{ type: "text", text: "after" },
				],
			},
		});
		const events = parseJsonlClaude(line);
		expect(events.map((e) => e.kind)).toEqual(["text"]);
		expect(events[0]?.payload).toEqual({ text: "after" });
	});

	test("top-level JSON arrays degrade to text events (do not flow through as payload)", () => {
		const line = '[{"type":"assistant"}]';
		const events = parseJsonlClaude(line);
		expect(events).toHaveLength(1);
		expect(events[0]?.kind).toBe("text");
		expect(events[0]?.payload).toEqual({ text: line });
		expect(Array.isArray(events[0]?.payload)).toBe(false);
	});

	test("emits one usage telemetry event after an assistant line's blocks (namphuongtran/warren#20)", () => {
		const usage = {
			input_tokens: 4,
			cache_creation_input_tokens: 1_200,
			cache_read_input_tokens: 150_000,
			output_tokens: 90,
			service_tier: "standard",
		};
		const line = JSON.stringify({
			type: "assistant",
			message: {
				id: "msg_01",
				type: "message",
				role: "assistant",
				model: "claude-sonnet-5-5",
				content: [{ type: "tool_use", id: "tu1", name: "Bash", input: { command: "ls" } }],
				stop_reason: null,
				usage,
			},
			parent_tool_use_id: null,
			session_id: "s1",
		});
		const events = parseJsonlClaude(line);
		expect(events.map((e) => e.kind)).toEqual(["tool_use", "telemetry"]);
		expect(events[1]).toEqual({
			kind: "telemetry",
			stream: "system",
			payload: {
				type: "assistant_usage",
				message: { id: "msg_01", model: "claude-sonnet-5-5", usage },
			},
		});
	});

	test("emits no usage event for a sub-agent's line, which measures another context", () => {
		const line = JSON.stringify({
			type: "assistant",
			message: {
				role: "assistant",
				model: "claude-haiku-4-5",
				content: [{ type: "text", text: "searching" }],
				usage: { input_tokens: 9_000, output_tokens: 3 },
			},
			parent_tool_use_id: "toolu_task",
		});
		expect(parseJsonlClaude(line).map((e) => e.kind)).toEqual(["text"]);
	});

	test("empty-text thinking-only assistant message yields zero events", () => {
		const line = JSON.stringify({
			type: "assistant",
			message: {
				role: "assistant",
				content: [{ type: "thinking", thinking: "" }],
			},
		});
		expect(parseJsonlClaude(line)).toEqual([]);
	});
});

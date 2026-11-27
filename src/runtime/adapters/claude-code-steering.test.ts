/**
 * The claude-code mid-run steering gate (namphuongtran/warren#150), fed lines
 * in claude's stream-json shape through the real parser.
 */

import { describe, expect, test } from "bun:test";
import { claudeCodeAdapter } from "./claude-code.ts";
import { parseJsonlClaude } from "./parsers/jsonl-claude.ts";
import type { SteeringGate } from "./types.ts";

function newGate(): SteeringGate {
	const gate = claudeCodeAdapter.createSteeringGate?.();
	if (gate === undefined) throw new Error("claude-code declares no steering gate");
	return gate;
}

function feed(gate: SteeringGate, line: Record<string, unknown>): boolean {
	for (const event of parseJsonlClaude(JSON.stringify(line))) gate.observe(event);
	return gate.isOpen();
}

const toolUse = (...calls: [id: string, name: string][]) => ({
	type: "assistant",
	message: { content: calls.map(([id, name]) => ({ type: "tool_use", id, name, input: {} })) },
	parent_tool_use_id: null,
});

const toolResult = (id: string) => ({
	type: "user",
	message: { content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] },
	parent_tool_use_id: null,
});

describe("claude-code steering gate", () => {
	test("opens while a tool call runs and closes on its result", () => {
		const gate = newGate();
		expect(gate.isOpen()).toBe(false);
		expect(feed(gate, toolUse(["t1", "Bash"]))).toBe(true);
		expect(feed(gate, toolResult("t1"))).toBe(false);
	});

	test("stays closed while a WebFetch or WebSearch call runs, even beside another call", () => {
		// The CLI can hand such a call's result to a later turn when a message
		// arrives (the SDK's `detachedToolCall`), and a later turn runs into reap.
		const gate = newGate();
		expect(feed(gate, toolUse(["w1", "WebFetch"]))).toBe(false);
		expect(feed(gate, toolUse(["b1", "Bash"], ["s1", "WebSearch"]))).toBe(false);
		expect(feed(gate, toolResult("w1"))).toBe(false);
		expect(feed(gate, toolResult("s1"))).toBe(true);
		expect(feed(gate, toolResult("b1"))).toBe(false);
	});

	test("ignores tool blocks with no usable id and results for calls it never saw", () => {
		const gate = newGate();
		gate.observe({ kind: "tool_use", stream: "stdout", payload: { name: "Bash" } });
		gate.observe({ kind: "tool_use", stream: "stdout", payload: "not an object" });
		gate.observe({ kind: "tool_use", stream: "stdout", payload: { id: 7, name: "Bash" } });
		expect(gate.isOpen()).toBe(false);

		expect(feed(gate, toolUse(["t1", "Bash"]))).toBe(true);
		gate.observe({ kind: "tool_result", stream: "stdout", payload: { tool_use_id: "other" } });
		gate.observe({ kind: "tool_result", stream: "stdout", payload: null });
		expect(gate.isOpen()).toBe(true);
	});

	test("closes at the turn's result even when a call never got its tool result", () => {
		const gate = newGate();
		expect(feed(gate, toolUse(["t1", "Bash"]))).toBe(true);
		expect(feed(gate, { type: "result", subtype: "error_during_execution", is_error: true })).toBe(
			false,
		);
	});
});

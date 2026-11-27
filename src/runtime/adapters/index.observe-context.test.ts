import { describe, expect, test } from "bun:test";
import type { EventEnvelopeInput } from "../../core/event-envelope.ts";
import { claudeCodeAdapter } from "./claude-code.ts";
import { isContextOnlyEvent, observeContext } from "./index.ts";

/** A pi `turn_end` as the pi parser persists it: `state_change` on `system`. */
function piTurnEnd(model: string, usage: Record<string, unknown>): EventEnvelopeInput {
	return {
		kind: "state_change",
		stream: "system",
		payload: { type: "turn_end", message: { role: "assistant", model, usage } },
	};
}

/** The usage event the claude-code parser emits for one stream-json `assistant` line. */
function claudeUsageEvent(model: string, usage: Record<string, unknown>): EventEnvelopeInput {
	const line = JSON.stringify({
		type: "assistant",
		message: {
			id: "msg_1",
			model,
			role: "assistant",
			content: [{ type: "text", text: "ok" }],
			usage,
		},
		parent_tool_use_id: null,
	});
	const event = claudeCodeAdapter.parseEvents?.(line).find((e) => e.kind === "telemetry");
	if (event === undefined) throw new Error("the claude-code parser emitted no usage event");
	return event;
}

describe("observeContext — claude-code assistant usage (namphuongtran/warren#20)", () => {
	test("sums the request's input, cache, and output tokens against the model's window", () => {
		const event = claudeUsageEvent("claude-sonnet-5-5", {
			input_tokens: 4,
			cache_creation_input_tokens: 1_200,
			cache_read_input_tokens: 150_000,
			output_tokens: 96,
		});

		expect(observeContext(event)).toEqual({
			tokensUsed: 151_300,
			windowTokens: 1_000_000,
			model: "claude-sonnet-5-5",
		});
	});

	test("reads the window of the dated snapshot id the API names", () => {
		const event = claudeUsageEvent("claude-sonnet-4-5-20250929", { input_tokens: 150_000 });

		expect(observeContext(event)?.windowTokens).toBe(200_000);
	});

	test("uses the 1M window when the run's model carries the [1m] suffix", () => {
		const event = claudeUsageEvent("claude-sonnet-4-5-20250929", { input_tokens: 300_000 });

		expect(observeContext(event, "claude-sonnet-4-5[1m]")).toEqual({
			tokensUsed: 300_000,
			windowTokens: 1_000_000,
			model: "claude-sonnet-4-5[1m]",
		});
	});

	test("stays silent for a Claude model whose window is not known", () => {
		expect(observeContext(claudeUsageEvent("claude-opus-9", { input_tokens: 9 }))).toBeNull();
	});

	test("stays silent for the CLI's synthetic messages, which used no tokens", () => {
		const event = claudeUsageEvent("<synthetic>", { input_tokens: 0, output_tokens: 0 });

		expect(observeContext(event)).toBeNull();
	});

	test("refuses a usage line the agent printed itself", () => {
		const event = {
			...claudeUsageEvent("claude-sonnet-5-5", { input_tokens: 9 }),
			origin: "agent",
		};

		expect(observeContext(event)).toBeNull();
	});
});

describe("isContextOnlyEvent (namphuongtran/warren#20)", () => {
	test("marks claude-code's usage event, which the bridge drops", () => {
		expect(isContextOnlyEvent(claudeUsageEvent("claude-sonnet-5-5", { input_tokens: 9 }))).toBe(
			true,
		);
	});

	test("keeps a usage-shaped line the agent printed itself", () => {
		const event = {
			...claudeUsageEvent("claude-sonnet-5-5", { input_tokens: 9 }),
			origin: "agent",
		};

		expect(isContextOnlyEvent(event)).toBe(false);
	});

	test("keeps pi's turn_end, which cost reads", () => {
		expect(isContextOnlyEvent(piTurnEnd("claude-haiku-4-5", { totalTokens: 10 }))).toBe(false);
	});
});

describe("observeContext — pi turn_end (namphuongtran/warren#20)", () => {
	test("reads the turn's total tokens against the model's window", () => {
		const event = piTurnEnd("claude-haiku-4-5", {
			input: 1684,
			output: 106,
			cacheRead: 150_000,
			cacheWrite: 10,
			totalTokens: 151_800,
		});

		expect(observeContext(event)).toEqual({
			tokensUsed: 151_800,
			windowTokens: 200_000,
			model: "claude-haiku-4-5",
		});
	});

	test("reads a routed model id by its last path segment", () => {
		const event = piTurnEnd("anthropic/claude-sonnet-5-5", { totalTokens: 10 });

		expect(observeContext(event)?.windowTokens).toBe(1_000_000);
	});

	test("stays silent for a model whose window the adapter does not know", () => {
		expect(observeContext(piTurnEnd("kimi-k3", { totalTokens: 90_000 }))).toBeNull();
	});

	test("stays silent for an errored turn that used no tokens", () => {
		expect(observeContext(piTurnEnd("claude-haiku-4-5", { totalTokens: 0 }))).toBeNull();
	});

	test("refuses a turn_end the agent printed itself", () => {
		const event = { ...piTurnEnd("claude-haiku-4-5", { totalTokens: 199_000 }), origin: "agent" };

		expect(observeContext(event)).toBeNull();
	});
});

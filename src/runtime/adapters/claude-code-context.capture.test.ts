/**
 * The context reader against real claude-code output (namphuongtran/warren#20).
 * The fixtures are claude-code 2.1.332 stream-json captures, trimmed of
 * account and path fields (`./parsers/__golden__/README.md`). They pin the two
 * facts the design rests on: the CLI repeats one request's usage on every
 * content-block line, and the window table matches the window the CLI itself
 * reports in its `result` line.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { EventEnvelopeInput } from "../../core/event-envelope.ts";
import { CLAUDE_USAGE_ENVELOPE_TYPE } from "./claude-code-context.ts";
import { claudeContextWindowTokens } from "./claude-context-windows.ts";
import { isContextOnlyEvent, observeContext } from "./index.ts";
import { parseJsonlClaude } from "./parsers/jsonl-claude.ts";

const GOLDEN_DIR = join(import.meta.dir, "parsers", "__golden__");

function captureLines(name: string): string[] {
	return readFileSync(join(GOLDEN_DIR, name), "utf8").split("\n").filter(Boolean);
}

function payloadType(event: EventEnvelopeInput): unknown {
	const payload = event.payload;
	return payload !== null && typeof payload === "object" ? Reflect.get(payload, "type") : undefined;
}

describe("claude-code context reading — real capture (CLI 2.1.332)", () => {
	const events = captureLines("claude-code-v2.1.332-tool-use.jsonl").flatMap(parseJsonlClaude);
	const usageEvents = events.filter((e) => payloadType(e) === CLAUDE_USAGE_ENVELOPE_TYPE);

	test("repeats one request's usage on each of its content-block lines", () => {
		// Request 1 wrote a text line and a tool_use line; request 2 one text line.
		expect(usageEvents).toHaveLength(3);
		expect(usageEvents[1]?.payload).toEqual(usageEvents[0]?.payload);
		expect(usageEvents[2]?.payload).not.toEqual(usageEvents[0]?.payload);
	});

	test("reads input + both cache counts + output against the model's 1M window", () => {
		expect(usageEvents.map((e) => observeContext(e, "claude-haiku-5-5"))).toEqual([
			{ tokensUsed: 2 + 7_794 + 12_328 + 1, windowTokens: 1_000_000, model: "claude-haiku-5-5" },
			{ tokensUsed: 2 + 7_794 + 12_328 + 1, windowTokens: 1_000_000, model: "claude-haiku-5-5" },
			{ tokensUsed: 2 + 111 + 20_122 + 3, windowTokens: 1_000_000, model: "claude-haiku-5-5" },
		]);
	});

	test("marks the usage events context-only and no other event", () => {
		for (const event of events) {
			expect(isContextOnlyEvent(event)).toBe(payloadType(event) === CLAUDE_USAGE_ENVELOPE_TYPE);
		}
	});
});

describe("claudeContextWindowTokens", () => {
	test("matches the window the CLI reported for every captured model", () => {
		const reported = captureLines("claude-code-v2.1.332-context-windows.jsonl")
			.map((line) => JSON.parse(line) as Record<string, unknown>)
			.filter((line) => line.type === "result")
			.flatMap((line) =>
				Object.entries(line.modelUsage as Record<string, { contextWindow: number }>).map(
					([model, usage]) => [model, usage.contextWindow] as const,
				),
			);

		expect(reported.length).toBeGreaterThanOrEqual(8);
		for (const [model, contextWindow] of reported) {
			expect({ model, window: claudeContextWindowTokens(model) }).toEqual({
				model,
				window: contextWindow,
			});
		}
	});

	test("maps the API's dated snapshot ids onto their family", () => {
		expect(claudeContextWindowTokens("claude-sonnet-4-5-20250929")).toBe(200_000);
		expect(claudeContextWindowTokens("claude-opus-4-5-20251101")).toBe(200_000);
	});

	test("reads a routed model id by its last path segment", () => {
		expect(claudeContextWindowTokens("anthropic/claude-sonnet-5-5")).toBe(1_000_000);
	});

	test("knows no window for a model the CLI was not captured with", () => {
		expect(claudeContextWindowTokens("claude-opus-9")).toBeNull();
		expect(claudeContextWindowTokens("<synthetic>")).toBeNull();
		expect(claudeContextWindowTokens("gpt-5.3-codex")).toBeNull();
	});
});

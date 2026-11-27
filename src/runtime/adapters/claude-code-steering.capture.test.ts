/**
 * The claude-code steering surface against real CLI output
 * (namphuongtran/warren#150). The fixtures are claude-code 2.1.332 stream-json
 * captures taken with stdin held open and `--replay-user-messages`, trimmed per
 * `./parsers/__golden__/README.md`. A replayed user line (`isReplay`) shows
 * where the CLI took a message in. Each test pins one CLI fact the adapter's
 * close trigger and steering gate rest on.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { claudeCodeAdapter } from "./claude-code.ts";
import { parseJsonlClaude } from "./parsers/jsonl-claude.ts";

const GOLDEN_DIR = join(import.meta.dir, "parsers", "__golden__");

interface Step {
	readonly line: Record<string, unknown>;
	/** The gate's answer after this line. */
	readonly open: boolean;
	/** Whether this line trips the stdin close trigger. */
	readonly closes: boolean;
}

/** Feed a capture through the parser, one fresh gate, and the close trigger. */
function replay(name: string): Step[] {
	const gate = claudeCodeAdapter.createSteeringGate?.();
	const close = claudeCodeAdapter.shouldCloseStdinOnEvent;
	if (gate === undefined || close === undefined) throw new Error("claude-code holds no stdin");
	return readFileSync(join(GOLDEN_DIR, name), "utf8")
		.split("\n")
		.filter(Boolean)
		.map((raw) => {
			const events = parseJsonlClaude(raw);
			for (const event of events) gate.observe(event);
			return {
				line: JSON.parse(raw) as Record<string, unknown>,
				open: gate.isOpen(),
				closes: events.some(close),
			};
		});
}

const results = (steps: Step[]): unknown[] =>
	steps.filter((s) => s.line.type === "result").map((s) => s.line.result);

const isSteerReplay = (step: Step): boolean =>
	step.line.isReplay === true && JSON.stringify(step.line.message).includes("[STEERING]");

describe("claudeCodeAdapter steering surface on real CLI 2.1.332 captures", () => {
	test("opens the gate for the tool call whose result the CLI sends with the steer", () => {
		// Lines: init, prompt, Bash tool_use, its result, steer, reply, result.
		const steps = replay("claude-code-v2.1.332-steer-mid-tool.jsonl");
		expect(steps.map((s) => s.open)).toEqual([false, false, true, false, false, false, false]);
		// The CLI took the steer in after the tool result, into the same turn.
		expect(steps.findIndex(isSteerReplay)).toBe(4);
		expect(results(steps)).toEqual(["PINEAPPLE"]);
		expect(steps.map((s) => s.closes)).toEqual([false, false, false, false, false, false, true]);
	});

	test("keeps the gate shut through a final request, whose steer the CLI runs as a second turn", () => {
		const steps = replay("claude-code-v2.1.332-steer-final-request.jsonl");
		expect(steps.some((s) => s.open)).toBe(false);
		const firstResult = steps.findIndex((s) => s.line.type === "result");
		expect(steps.findIndex(isSteerReplay)).toBeGreaterThan(firstResult);
		expect(results(steps)).toHaveLength(2);
		expect(results(steps)[1]).toBe("PINEAPPLE");
		expect(steps.filter((s) => s.closes)).toHaveLength(2);
	});

	test("keeps the gate open through a sub-agent's calls until the parent call returns", () => {
		// Lines: init, prompt, Agent tool_use, sub-agent prompt, its Bash tool_use,
		// that result, the Agent result, steer, reply, result.
		const steps = replay("claude-code-v2.1.332-steer-subagent.jsonl");
		expect(steps.map((s) => s.open)).toEqual([
			false,
			false,
			true,
			true,
			true,
			true,
			false,
			false,
			false,
			false,
		]);
		const steer = steps.find(isSteerReplay);
		expect(steer?.line.parent_tool_use_id).toBeNull();
		expect(results(steps)).toEqual(["PINEAPPLE"]);
	});

	test("records one turn per stdin line and one turn for a two-block message", () => {
		expect(results(replay("claude-code-v2.1.332-spawn-two-lines.jsonl"))).toEqual([
			"DONE",
			"PINEAPPLE",
		]);
		expect(results(replay("claude-code-v2.1.332-spawn-one-message.jsonl"))).toEqual(["PINEAPPLE"]);
	});
});

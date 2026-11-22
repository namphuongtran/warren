import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { RuntimeId } from "../../core/wire.ts";
import { adapterFor } from "../../runtime/adapters/index.ts";
import { deriveQualityGateOutcome, type GateToolEvent } from "./outcome.ts";

const GATE = "bun run check:all --bail";

/** Replay a recorded harness stdout fixture through the runtime's real parser. */
function eventsFrom(runtime: RuntimeId, fixture: string): GateToolEvent[] {
	const parse = adapterFor(runtime).parseEvents;
	if (parse === undefined) throw new Error(`${runtime} has no parser`);
	const text = readFileSync(join(import.meta.dir, "__fixtures__", fixture), "utf8");
	const events: GateToolEvent[] = [];
	for (const line of text.split("\n")) {
		for (const ev of parse(line)) {
			events.push({ kind: ev.kind, payload: ev.payload });
		}
	}
	return events;
}

/** Parse claude-code stream-json lines for one Bash call (and its result, unless omitted). */
function claudeBashCall(
	command: string,
	result?: { readonly content: string; readonly isError: boolean },
): GateToolEvent[] {
	const lines = [
		{
			type: "assistant",
			message: {
				role: "assistant",
				content: [{ type: "tool_use", id: "toolu_inline", name: "Bash", input: { command } }],
			},
		},
	];
	if (result !== undefined) {
		const block = {
			type: "tool_result",
			tool_use_id: "toolu_inline",
			content: result.content,
			is_error: result.isError,
		};
		lines.push({ type: "user", message: { role: "user", content: [block] } } as never);
	}
	const parse = adapterFor("claude-code").parseEvents;
	if (parse === undefined) throw new Error("claude-code has no parser");
	return lines
		.flatMap((line) => parse(JSON.stringify(line)))
		.map((ev) => ({ kind: ev.kind, payload: ev.payload }));
}

describe("deriveQualityGateOutcome", () => {
	test("reads passed when the last gate call exited zero with no edit after it (claude-code)", () => {
		const events = eventsFrom("claude-code", "claude-code-gate-passed.jsonl");
		const result = deriveQualityGateOutcome({ gateCommand: GATE, runtime: "claude-code", events });
		expect(result.outcome).toBe("passed");
	});

	test("reads failed when the last gate call exited non-zero, even after an earlier pass (pi)", () => {
		const events = eventsFrom("pi", "pi-gate-failed.jsonl");
		const result = deriveQualityGateOutcome({ gateCommand: GATE, runtime: "pi", events });
		expect(result.outcome).toBe("failed");
	});

	test("reads stale when a file edit lands after the last passing gate call (claude-code)", () => {
		const events = eventsFrom("claude-code", "claude-code-gate-stale.jsonl");
		const result = deriveQualityGateOutcome({ gateCommand: GATE, runtime: "claude-code", events });
		expect(result).toMatchObject({ outcome: "stale", editsAfterGate: 1 });
	});

	test("reads unconfigured, not not_run, when the project sets no gate", () => {
		const events = eventsFrom("claude-code", "claude-code-gate-passed.jsonl");
		const result = deriveQualityGateOutcome({ gateCommand: null, runtime: "claude-code", events });
		expect(result.outcome).toBe("unconfigured");
	});

	test("reads not_run when no tool call invoked the configured gate (pi)", () => {
		const events = eventsFrom("pi", "pi-gate-failed.jsonl");
		const result = deriveQualityGateOutcome({ gateCommand: "make check", runtime: "pi", events });
		expect(result.outcome).toBe("not_run");
	});

	test("matches a call that runs the gate through $WARREN_QUALITY_GATE (claude-code)", () => {
		const events = eventsFrom("claude-code", "claude-code-gate-env.jsonl");
		const result = deriveQualityGateOutcome({ gateCommand: GATE, runtime: "claude-code", events });
		expect(result.outcome).toBe("failed");
	});

	test("reads unknown when a pipe masks the gate's exit status (claude-code)", () => {
		const events = eventsFrom("claude-code", "claude-code-gate-masked.jsonl");
		const result = deriveQualityGateOutcome({ gateCommand: GATE, runtime: "claude-code", events });
		expect(result).toMatchObject({ outcome: "unknown", unknownReason: "exit_status_masked" });
	});

	test("reads a masked gate's exit status from an exit=N marker in its output (pi)", () => {
		const events = eventsFrom("pi", "pi-gate-exit-marker.jsonl");
		const result = deriveQualityGateOutcome({ gateCommand: GATE, runtime: "pi", events });
		expect(result.outcome).toBe("failed");
	});

	test("reads unknown when the last gate call has no recorded result", () => {
		const events = claudeBashCall(GATE);
		const result = deriveQualityGateOutcome({ gateCommand: GATE, runtime: "claude-code", events });
		expect(result).toMatchObject({ outcome: "unknown", unknownReason: "no_result" });
	});

	test.each([
		["an && chain", `cd /workspace && ${GATE} && echo green`],
		["pipefail set before a pipe", `set -o pipefail; ${GATE} 2>&1 | tail -40`],
		["redirections only", `${GATE} > /tmp/gate.log 2>&1`],
	])("trusts the exit status through %s", (_label, command) => {
		const events = claudeBashCall(command, { content: "12/12 gates passed", isError: false });
		const result = deriveQualityGateOutcome({ gateCommand: GATE, runtime: "claude-code", events });
		expect(result.outcome).toBe("passed");
	});

	test.each([
		["a redirect target followed by ;", `${GATE} > /tmp/gate.log; echo done`],
		["an &> redirect followed by ;", `${GATE} &>/tmp/gate.log; echo done`],
		["a redirect followed by || true", `${GATE} >/tmp/gate.log|| true`],
	])("reads unknown when %s masks the exit status", (_label, command) => {
		const events = claudeBashCall(command, { content: "done", isError: false });
		const result = deriveQualityGateOutcome({ gateCommand: GATE, runtime: "claude-code", events });
		expect(result).toMatchObject({ outcome: "unknown", unknownReason: "exit_status_masked" });
	});

	test.each([
		["a commit message that quotes it", `git commit -m "verified with ${GATE}"`],
		["an echo of the env var", "echo $WARREN_QUALITY_GATE"],
		["a longer env var name", "$WARREN_QUALITY_GATE_LOG"],
		["a different script sharing its prefix", "bun run check:all-fast --bail"],
		["a focused run with extra arguments", `${GATE} src/one.test.ts`],
	])("does not count %s as a gate call", (_label, command) => {
		const events = claudeBashCall(command, { content: "ok", isError: false });
		const result = deriveQualityGateOutcome({ gateCommand: GATE, runtime: "claude-code", events });
		expect(result.outcome).toBe("not_run");
	});

	test.each([
		["a quoted ; after an && chain", `${GATE} && echo "ok; done"`],
		["eval of the quoted env var", 'eval "$WARREN_QUALITY_GATE"'],
		["leading env assignments", `CI=1 FORCE_COLOR=0 ${GATE}`],
		["bash -c around the gate", `bash -lc '${GATE}'`],
	])("counts %s as a trusted gate call", (_label, command) => {
		const events = claudeBashCall(command, { content: "12/12 gates passed", isError: false });
		const result = deriveQualityGateOutcome({ gateCommand: GATE, runtime: "claude-code", events });
		expect(result.outcome).toBe("passed");
	});

	test("matches a compound gate as its whole chain of commands", () => {
		const gate = "cd backend && make check";
		const events = claudeBashCall("cd backend && make check", { content: "ok", isError: false });
		const partial = claudeBashCall("make check", { content: "ok", isError: false });
		expect(
			deriveQualityGateOutcome({ gateCommand: gate, runtime: "claude-code", events }).outcome,
		).toBe("passed");
		expect(
			deriveQualityGateOutcome({ gateCommand: gate, runtime: "claude-code", events: partial })
				.outcome,
		).toBe("not_run");
	});

	test("reads stale when a pi edit lands after the last passing gate call", () => {
		const events = eventsFrom("pi", "pi-gate-stale.jsonl");
		const result = deriveQualityGateOutcome({ gateCommand: GATE, runtime: "pi", events });
		expect(result).toMatchObject({ outcome: "stale", editsAfterGate: 1 });
	});
});

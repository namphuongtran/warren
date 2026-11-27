/**
 * When a mid-run steer can reach a claude-code agent (namphuongtran/warren#150).
 *
 * claude-code `--input-format stream-json` reads stdin while a turn runs. A
 * message it reads goes into the turn's next model request, after the tool
 * results. A turn with no next request ends with `result`, and the CLI then runs
 * the queued message as a turn of its own. Warren reaps a run at its first
 * `result`, so that turn runs into reap. The captures in
 * `./parsers/__golden__/claude-code-v2.1.332-steer-*.jsonl` show both cases.
 *
 * The gate is open while a tool call is outstanding: the CLI must send its
 * result back in another request, and a steer written now rides that request.
 * A sub-agent's calls run inside the parent's outstanding call, so they never
 * change the answer.
 *
 * Two tools keep the gate closed while they run. The Agent SDK documents that
 * a WebFetch or WebSearch call can step aside for a message the user sent and
 * hand its result to a later turn (`detachedToolCall`). That later turn would
 * run into reap the same way.
 *
 * The gate sees the events warren has parsed, so it trails the CLI by the time
 * a line takes to reach warren. A steer written in that instant after a tool
 * call ends can miss the next request. It runs as a turn of its own only when
 * that request was the turn's last.
 */

import { extractAgentEventEnvelope } from "../../core/event-envelope.ts";
import type { AdapterRuntimeEvent, SteeringGate } from "./types.ts";

const DETACHABLE_TOOLS: ReadonlySet<string> = new Set(["WebFetch", "WebSearch"]);

export function createClaudeSteeringGate(): SteeringGate {
	// Outstanding call id → its tool name, when the block names one.
	const outstanding = new Map<string, string | undefined>();
	return {
		observe(event) {
			if (isClaudeResult(event)) {
				outstanding.clear();
			} else if (event.kind === "tool_use") {
				const id = stringField(event.payload, "id");
				if (id !== undefined) outstanding.set(id, stringField(event.payload, "name"));
			} else if (event.kind === "tool_result") {
				const id = stringField(event.payload, "tool_use_id");
				if (id !== undefined) outstanding.delete(id);
			}
		},
		isOpen() {
			if (outstanding.size === 0) return false;
			for (const name of outstanding.values()) {
				if (name !== undefined && DETACHABLE_TOOLS.has(name)) return false;
			}
			return true;
		},
	};
}

/** True for the CLI's end-of-turn `result` line, success or error. */
export function isClaudeResult(event: AdapterRuntimeEvent): boolean {
	return extractAgentEventEnvelope(event)?.type === "result";
}

function stringField(payload: unknown, key: string): string | undefined {
	if (payload === null || typeof payload !== "object") return undefined;
	const value = Reflect.get(payload, key);
	return typeof value === "string" ? value : undefined;
}

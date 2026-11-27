/**
 * The local drive's mid-run steering loop with an adapter that gates delivery
 * (namphuongtran/warren#150): claude-code, fed its own stream-json lines.
 */

import { describe, expect, test } from "bun:test";
import type { SpawnResult } from "../../sandbox/types.ts";
import { claudeCodeAdapter } from "../adapters/claude-code.ts";
import { createStdinController, startMidRunSteering } from "./drive-stdin.ts";
import { LocalRunStore } from "./run-store.ts";

function fakeProc(writes: string[]): SpawnResult {
	const empty = new ReadableStream<Uint8Array>({ start: (ctrl) => ctrl.close() });
	return {
		pid: 1,
		stdout: empty,
		stderr: empty,
		exited: new Promise<number>(() => {}),
		cancel: () => {},
		closeStdin: () => Promise.resolve(),
		writeStdin: (chunk) => {
			writes.push(chunk);
			return Promise.resolve();
		},
	};
}

const claudeLine = (line: Record<string, unknown>) =>
	claudeCodeAdapter.parseEvents?.(JSON.stringify(line)) ?? [];

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 40));

describe("startMidRunSteering with a steering gate", () => {
	test("holds a pending message until a tool call opens the gate", async () => {
		const store = new LocalRunStore();
		const record = store.create({
			runId: "run_gate",
			sandboxId: "local-run_gate",
			workspacePath: "/tmp/ws",
			homePath: "/tmp/home",
			branch: "warren/run_gate",
		});
		const writes: string[] = [];
		const proc = fakeProc(writes);
		const stdin = createStdinController(claudeCodeAdapter, proc, true);
		const steering = startMidRunSteering(store, record, claudeCodeAdapter, proc, stdin, {
			midRunInboxPollMs: 5,
		});
		store.sendMessage(record, { body: "wrap up", priority: "high" });

		await settle();
		expect(writes).toEqual([]);
		expect(store.listPending(record)).toHaveLength(1);

		stdin.observe(
			claudeLine({
				type: "assistant",
				message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }] },
				parent_tool_use_id: null,
			}),
		);
		await settle();
		expect(writes).toHaveLength(1);
		expect(writes[0]).toContain("[STEERING] (priority: high) wrap up");
		expect(store.listPending(record)).toHaveLength(0);

		steering.abort();
		await steering.done;
	});
});

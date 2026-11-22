/**
 * Tool-call stall kill (namphuongtran/warren#83).
 *
 * Off by default. When an operator sets a kill threshold, a tool call open
 * past it force-fails the run through the same reap path as the heartbeat
 * timeout, so partial work is still pushed.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { openDatabase, type WarrenDb } from "../db/client.ts";
import { createRepos, type Repos } from "../db/repos/index.ts";
import type { ReapRunInput } from "./reap/index.ts";
import {
	fakeReapResult,
	isoPlus,
	makeCancelProvider,
	seedHungToolCall,
	seedRunningRun,
	seedWatchdogFixtures,
} from "./watchdog.test-helpers.ts";
import { tickWatchdog, WATCHDOG_TIMED_OUT_KIND, type WatchdogTickDeps } from "./watchdog.ts";
import { WATCHDOG_TOOL_STALLED_KIND } from "./watchdog-tool-stall.ts";

const STARTED_AT = "2026-11-22T10:00:00.000Z";
const TOOL_USE_AT = "2026-11-22T10:05:00.000Z";
const TOOL_USE_ID = "toolu_016v62cYWga7ttHSxU7F6Qkt";
const MIN = 60_000;

let db: WarrenDb;
let repos: Repos;
let reapCalls: ReapRunInput[];

beforeEach(async () => {
	db = await openDatabase({ path: ":memory:" });
	repos = createRepos(db);
	reapCalls = [];
	await seedWatchdogFixtures(repos);
});

afterEach(async () => {
	await db.close();
});

function deps(nowIso: string, over: Partial<WatchdogTickDeps> = {}): WatchdogTickDeps {
	return {
		repos,
		runtimeProvider: makeCancelProvider([]),
		heartbeatTimeoutMs: 45 * MIN,
		toolStallWarnMs: 15 * MIN,
		now: () => new Date(nowIso),
		reap: async (input) => {
			reapCalls.push(input);
			return fakeReapResult("failed");
		},
		...over,
	};
}

async function eventsOfKind(runId: string, kind: string) {
	return (await repos.events.listByRun(runId)).filter((e) => e.kind === kind);
}

describe("tickWatchdog tool-stall kill", () => {
	test("force-fails a run whose tool call is open past the kill threshold", async () => {
		const runId = await seedRunningRun(repos, STARTED_AT);
		await seedHungToolCall(repos, runId, {
			toolUseAt: TOOL_USE_AT,
			toolUseId: TOOL_USE_ID,
			heartbeats: 62,
		});

		const result = await tickWatchdog(
			deps(isoPlus(TOOL_USE_AT, 31 * MIN), { toolStallKillMs: 30 * MIN }),
		);

		expect(result.timedOut).toEqual([{ runId, idleMs: 31 * MIN }]);
		expect(reapCalls.map((c) => [c.runId, c.outcome, c.failureReason])).toEqual([
			[runId, "failed", "timed_out"],
		]);
		const timedOut = await eventsOfKind(runId, WATCHDOG_TIMED_OUT_KIND);
		expect(timedOut).toHaveLength(1);
		expect(timedOut[0]?.payloadJson).toMatchObject({
			cause: "tool_stall",
			toolUseId: TOOL_USE_ID,
			toolName: "Bash",
			toolElapsedMs: 31 * MIN,
			toolStallKillMs: 30 * MIN,
		});
	});

	test("only warns between the warning and the kill threshold", async () => {
		const runId = await seedRunningRun(repos, STARTED_AT);
		await seedHungToolCall(repos, runId, {
			toolUseAt: TOOL_USE_AT,
			toolUseId: TOOL_USE_ID,
			heartbeats: 40,
		});

		const result = await tickWatchdog(
			deps(isoPlus(TOOL_USE_AT, 20 * MIN), { toolStallKillMs: 30 * MIN }),
		);

		expect(result.timedOut).toEqual([]);
		expect(result.stalled.map((s) => s.toolUseId)).toEqual([TOOL_USE_ID]);
		expect(reapCalls).toEqual([]);
		expect((await repos.runs.require(runId)).state).toBe("running");
	});

	test("never kills when no kill threshold is set", async () => {
		const runId = await seedRunningRun(repos, STARTED_AT);
		await seedHungToolCall(repos, runId, {
			toolUseAt: TOOL_USE_AT,
			toolUseId: TOOL_USE_ID,
			heartbeats: 62,
		});
		// A text event keeps the idle clock under the 45-minute budget.
		await repos.events.append({
			runId,
			sandboxEventSeq: 100,
			ts: isoPlus(TOOL_USE_AT, 40 * MIN),
			kind: "text",
			stream: "stdout",
			payload: { type: "text", text: "still waiting on pytest" },
		});

		const result = await tickWatchdog(deps(isoPlus(TOOL_USE_AT, 44 * MIN)));

		expect(result.timedOut).toEqual([]);
		expect(reapCalls).toEqual([]);
		expect(await eventsOfKind(runId, WATCHDOG_TOOL_STALLED_KIND)).toHaveLength(1);
	});

	test("lets a project kill threshold apply when the instance sets none", async () => {
		const runId = await seedRunningRun(repos, STARTED_AT);
		await seedHungToolCall(repos, runId, {
			toolUseAt: TOOL_USE_AT,
			toolUseId: TOOL_USE_ID,
			heartbeats: 50,
		});
		const resolveToolStallLimits = async () => ({ killMs: 20 * MIN });

		const result = await tickWatchdog(
			deps(isoPlus(TOOL_USE_AT, 25 * MIN), { resolveToolStallLimits }),
		);

		expect(result.timedOut.map((t) => t.runId)).toEqual([runId]);
	});
});

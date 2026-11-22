/**
 * Harness keep-alive events and the watchdog idle clock (namphuongtran/warren#83).
 *
 * Claude Code emits a `tool_progress` heartbeat every 30 s while a tool runs.
 * Before the fix each one reset the idle clock, so a tool call that never
 * returned kept the run looking healthy forever. The fixture is the
 * `run_zdpqf4a4m8en` shape: one `tool_use`, then only heartbeats.
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
import { computeIdleMs, tickWatchdog } from "./watchdog.ts";

const STARTED_AT = "2026-11-22T10:00:00.000Z";
const HUNG_CALL = {
	toolUseAt: "2026-11-22T10:05:00.000Z",
	toolUseId: "toolu_016v62cYWga7ttHSxU7F6Qkt",
	heartbeats: 100, // 50 minutes of 30 s heartbeats
};
const BUDGET_MS = 45 * 60_000;
// The tool_use is 50 min older than the newest heartbeat; "now" is 30 s past it.
const IDLE_FROM_TOOL_USE_MS = 50 * 60_000 + 30_000;

let db: WarrenDb;
let repos: Repos;

beforeEach(async () => {
	db = await openDatabase({ path: ":memory:" });
	repos = createRepos(db);
	await seedWatchdogFixtures(repos);
});

afterEach(async () => {
	await db.close();
});

describe("computeIdleMs", () => {
	test("ignores tool_progress heartbeats and anchors on the tool_use", async () => {
		const runId = await seedRunningRun(repos, STARTED_AT);
		const { lastTs } = await seedHungToolCall(repos, runId, HUNG_CALL);
		const run = await repos.runs.require(runId);

		const idle = await computeIdleMs(repos, run, new Date(isoPlus(lastTs, 30_000)));

		expect(idle).toBe(IDLE_FROM_TOOL_USE_MS);
	});

	test("reads idle from the newest heartbeat when the keep-alive list is empty", async () => {
		// Negative control: without the filter the same log looks 30 s old.
		const runId = await seedRunningRun(repos, STARTED_AT);
		const { lastTs } = await seedHungToolCall(repos, runId, HUNG_CALL);
		const run = await repos.runs.require(runId);

		const idle = await computeIdleMs(repos, run, new Date(isoPlus(lastTs, 30_000)), {
			keepAliveEnvelopeTypes: [],
		});

		expect(idle).toBe(30_000);
	});

	test("falls back to startedAt when only heartbeats have flowed", async () => {
		const runId = await seedRunningRun(repos, STARTED_AT);
		await repos.events.append({
			runId,
			sandboxEventSeq: 1,
			ts: isoPlus(STARTED_AT, 60_000),
			kind: "text",
			stream: "stdout",
			payload: { type: "tool_progress", heartbeat: true },
		});
		const run = await repos.runs.require(runId);

		const idle = await computeIdleMs(repos, run, new Date(isoPlus(STARTED_AT, 120_000)));

		expect(idle).toBe(120_000);
	});
});

describe("tickWatchdog", () => {
	test("force-fails a run whose only events past the budget are heartbeats", async () => {
		const runId = await seedRunningRun(repos, STARTED_AT);
		const { lastTs } = await seedHungToolCall(repos, runId, HUNG_CALL);
		const reapCalls: ReapRunInput[] = [];

		const result = await tickWatchdog({
			repos,
			runtimeProvider: makeCancelProvider([]),
			heartbeatTimeoutMs: BUDGET_MS,
			now: () => new Date(isoPlus(lastTs, 30_000)),
			reap: async (input) => {
				reapCalls.push(input);
				return fakeReapResult("failed");
			},
		});

		expect(result.timedOut).toEqual([{ runId, idleMs: IDLE_FROM_TOOL_USE_MS }]);
		expect(reapCalls.map((c) => c.failureReason)).toEqual(["timed_out"]);
	});
});

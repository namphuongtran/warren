/**
 * Tool-call stall warning (namphuongtran/warren#83).
 *
 * One tool call open past the stall threshold gets exactly one
 * `watchdog.tool_stalled` event. The run stays `running`: a long gate can be
 * legitimate, so this warns and never kills.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { openDatabase, type WarrenDb } from "../db/client.ts";
import { createRepos, type Repos } from "../db/repos/index.ts";
import type { WarrenConfigCache } from "../warren-config/index.ts";
import type { ReapRunInput } from "./reap/index.ts";
import {
	fakeReapResult,
	isoPlus,
	makeCancelProvider,
	PROJECT_ID,
	seedHungToolCall,
	seedRunningRun,
	seedWatchdogFixtures,
} from "./watchdog.test-helpers.ts";
import { tickWatchdog, type WatchdogTickDeps } from "./watchdog.ts";
import { projectToolStallResolver, WATCHDOG_TOOL_STALLED_KIND } from "./watchdog-tool-stall.ts";

const STARTED_AT = "2026-11-22T10:00:00.000Z";
const TOOL_USE_AT = "2026-11-22T10:05:00.000Z";
const TOOL_USE_ID = "toolu_016v62cYWga7ttHSxU7F6Qkt";
const STALL_MS = 15 * 60_000;

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
		heartbeatTimeoutMs: 45 * 60_000,
		toolStallWarnMs: STALL_MS,
		now: () => new Date(nowIso),
		reap: async (input) => {
			reapCalls.push(input);
			return fakeReapResult("failed");
		},
		...over,
	};
}

async function stalledEvents(runId: string) {
	const events = await repos.events.listByRun(runId);
	return events.filter((e) => e.kind === WATCHDOG_TOOL_STALLED_KIND);
}

describe("tickWatchdog tool-stall warning", () => {
	test("warns once for a tool call open past the threshold and leaves the run running", async () => {
		const runId = await seedRunningRun(repos, STARTED_AT);
		// 20 minutes of heartbeats after the tool_use.
		await seedHungToolCall(repos, runId, {
			toolUseAt: TOOL_USE_AT,
			toolUseId: TOOL_USE_ID,
			heartbeats: 40,
		});

		const first = await tickWatchdog(deps(isoPlus(TOOL_USE_AT, 20 * 60_000)));
		const second = await tickWatchdog(deps(isoPlus(TOOL_USE_AT, 20 * 60_000 + 30_000)));

		expect(first.stalled).toEqual([
			{ runId, toolUseId: TOOL_USE_ID, toolName: "Bash", elapsedMs: 20 * 60_000 },
		]);
		expect(second.stalled).toEqual([]);
		const events = await stalledEvents(runId);
		expect(events).toHaveLength(1);
		expect(events[0]?.stream).toBe("system");
		expect(events[0]?.payloadJson).toEqual({
			toolUseId: TOOL_USE_ID,
			toolName: "Bash",
			command: "uv run pytest -q",
			elapsedMs: 20 * 60_000,
			toolStallWarnMs: STALL_MS,
		});
		expect((await repos.runs.require(runId)).state).toBe("running");
		expect(first.timedOut).toEqual([]);
		expect(second.timedOut).toEqual([]);
		expect(reapCalls).toEqual([]);
	});

	test("does not warn when the tool_result arrives before the threshold", async () => {
		const runId = await seedRunningRun(repos, STARTED_AT);
		const { nextSeq } = await seedHungToolCall(repos, runId, {
			toolUseAt: TOOL_USE_AT,
			toolUseId: TOOL_USE_ID,
			heartbeats: 10,
		});
		await repos.events.append({
			runId,
			sandboxEventSeq: nextSeq,
			ts: isoPlus(TOOL_USE_AT, 6 * 60_000),
			kind: "tool_result",
			stream: "stdout",
			payload: { type: "tool_result", tool_use_id: TOOL_USE_ID, content: "1 failed" },
		});

		const result = await tickWatchdog(deps(isoPlus(TOOL_USE_AT, 25 * 60_000)));

		expect(result.stalled).toEqual([]);
		expect(await stalledEvents(runId)).toEqual([]);
	});

	test("warns about the hung call of a parallel pair after its sibling returns", async () => {
		const runId = await seedRunningRun(repos, STARTED_AT);
		const { nextSeq } = await seedHungToolCall(repos, runId, {
			toolUseAt: TOOL_USE_AT,
			toolUseId: TOOL_USE_ID,
			heartbeats: 0,
		});
		// The sibling call opens in the same assistant message and returns at +10 min.
		await repos.events.append({
			runId,
			sandboxEventSeq: nextSeq,
			ts: TOOL_USE_AT,
			kind: "tool_use",
			stream: "stdout",
			payload: { type: "tool_use", id: "toolu_sibling", name: "Read", input: {} },
		});
		await repos.events.append({
			runId,
			sandboxEventSeq: nextSeq + 1,
			ts: isoPlus(TOOL_USE_AT, 10 * 60_000),
			kind: "tool_result",
			stream: "stdout",
			payload: { type: "tool_result", tool_use_id: "toolu_sibling", content: "ok" },
		});

		const result = await tickWatchdog(deps(isoPlus(TOOL_USE_AT, 20 * 60_000)));

		expect(result.stalled).toEqual([
			{ runId, toolUseId: TOOL_USE_ID, toolName: "Bash", elapsedMs: 20 * 60_000 },
		]);
	});

	test("lets a project threshold override the default", async () => {
		const runId = await seedRunningRun(repos, STARTED_AT);
		await seedHungToolCall(repos, runId, {
			toolUseAt: TOOL_USE_AT,
			toolUseId: TOOL_USE_ID,
			heartbeats: 40,
		});
		const resolveToolStallLimits = async () => ({ warnMs: 30 * 60_000 });

		const result = await tickWatchdog(
			deps(isoPlus(TOOL_USE_AT, 20 * 60_000), { resolveToolStallLimits }),
		);

		expect(result.stalled).toEqual([]);
		expect(await stalledEvents(runId)).toEqual([]);
	});
});

describe("projectToolStallResolver", () => {
	function cacheReturning(get: WarrenConfigCache["get"]): WarrenConfigCache {
		return { get, invalidate: () => {}, clear: () => {}, size: () => 0 };
	}

	test("reads both stall thresholds from the run's project config, in ms", async () => {
		const runId = await seedRunningRun(repos, STARTED_AT);
		const seen: string[] = [];
		const resolve = projectToolStallResolver({
			repos,
			warrenConfigs: cacheReturning(async (projectId) => {
				seen.push(projectId);
				return { defaults: { toolStallWarnMinutes: 30, toolStallKillMinutes: 60 } } as Awaited<
					ReturnType<WarrenConfigCache["get"]>
				>;
			}),
		});

		expect(await resolve(await repos.runs.require(runId))).toEqual({
			warnMs: 30 * 60_000,
			killMs: 60 * 60_000,
		});
		expect(seen).toEqual([PROJECT_ID]);
	});

	test("falls back to the instance default when the config read fails", async () => {
		const runId = await seedRunningRun(repos, STARTED_AT);
		const resolve = projectToolStallResolver({
			repos,
			warrenConfigs: cacheReturning(async () => {
				throw new Error("project clone missing on disk");
			}),
		});

		expect(await resolve(await repos.runs.require(runId))).toEqual({});
	});
});

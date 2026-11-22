/**
 * The stalled-run view behind the runs list and run page marker
 * (namphuongtran/warren#83): a running run is stalled while the call its
 * newest `watchdog.tool_stalled` warning names is still open.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { openDatabase, type WarrenDb } from "../db/client.ts";
import { createRepos, type Repos } from "../db/repos/index.ts";
import { currentToolStalls } from "./tool-stall-view.ts";
import {
	isoPlus,
	makeCancelProvider,
	seedHungToolCall,
	seedRunningRun,
	seedWatchdogFixtures,
} from "./watchdog.test-helpers.ts";
import { tickWatchdog } from "./watchdog.ts";

const STARTED_AT = "2026-11-22T10:00:00.000Z";
const TOOL_USE_AT = "2026-11-22T10:05:00.000Z";
const TOOL_USE_ID = "toolu_016v62cYWga7ttHSxU7F6Qkt";
const WARNED_AT = isoPlus(TOOL_USE_AT, 20 * 60_000);

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

/** A running run whose Bash call the watchdog has warned about at +20 min. */
async function seedStalledRun(): Promise<{ runId: string; nextSeq: number }> {
	const runId = await seedRunningRun(repos, STARTED_AT);
	await seedHungToolCall(repos, runId, {
		toolUseAt: TOOL_USE_AT,
		toolUseId: TOOL_USE_ID,
		heartbeats: 40,
	});
	await tickWatchdog({
		repos,
		runtimeProvider: makeCancelProvider([]),
		heartbeatTimeoutMs: 45 * 60_000,
		toolStallWarnMs: 15 * 60_000,
		now: () => new Date(WARNED_AT),
		reap: async () => {
			throw new Error("the warning must not reap");
		},
	});
	return { runId, nextSeq: (await repos.events.maxSeqForRun(runId)) ?? 0 };
}

async function stallsFor(...runIds: string[]) {
	const runs = await Promise.all(runIds.map((id) => repos.runs.require(id)));
	return currentToolStalls(repos, runs);
}

describe("currentToolStalls", () => {
	test("reports a running run whose warned call is still open", async () => {
		const { runId } = await seedStalledRun();

		const stalls = await stallsFor(runId);

		expect(Object.fromEntries(stalls)).toEqual({
			[runId]: {
				toolUseId: TOOL_USE_ID,
				toolName: "Bash",
				command: "uv run pytest -q",
				openedAt: TOOL_USE_AT,
				warnedAt: WARNED_AT,
			},
		});
	});

	test("clears once the warned call returns", async () => {
		const { runId, nextSeq } = await seedStalledRun();
		await repos.events.append({
			runId,
			sandboxEventSeq: nextSeq + 1,
			ts: isoPlus(WARNED_AT, 60_000),
			kind: "tool_result",
			stream: "stdout",
			payload: { type: "tool_result", tool_use_id: TOOL_USE_ID, content: "1 failed" },
		});

		expect((await stallsFor(runId)).size).toBe(0);
	});

	test("ignores a run that is no longer running", async () => {
		const { runId } = await seedStalledRun();
		await repos.runs.finalize(runId, "failed", new Date(WARNED_AT), "timed_out");

		expect((await stallsFor(runId)).size).toBe(0);
	});

	test("leaves out a running run the watchdog never warned about", async () => {
		const quiet = await seedRunningRun(repos, STARTED_AT);
		const { runId } = await seedStalledRun();

		expect([...(await stallsFor(quiet, runId)).keys()]).toEqual([runId]);
	});
});

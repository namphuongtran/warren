/**
 * The quota hold releaser (namphuongtran/warren#30): a held run is launched
 * as the same row once its window reopens, held again when the window moved,
 * and never launched after a cancel.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { QUOTA_HOLD_EVENTS } from "../../core/wire.ts";
import type { WarrenDb } from "../../db/client.ts";
import type { Repos } from "../../db/repos/index.ts";
import { FakeProvider } from "../../runtime/fake/fake-provider.ts";
import { spawnOrHoldRun } from "../spawn/index.ts";
import { makeAgentJson, setupRepos } from "../spawn/test-helpers.ts";
import { createQuotaHoldReleaser } from "./hold-release.ts";
import { recordQuotaObservation } from "./state.ts";

const RESETS_AT = 1795338600;
const HELD_AT = new Date("2026-11-22T08:50:43.000Z");
const BEFORE_RELEASE = new Date((RESETS_AT + 30) * 1000);
const AFTER_RELEASE = new Date((RESETS_AT + 200) * 1000);
const SERVER_ENV = { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-dispatch-secret" };

describe("createQuotaHoldReleaser", () => {
	let db: WarrenDb;
	let repos: Repos;
	let provider: FakeProvider;
	let clock: Date;
	let started: string[];

	async function rejectUntil(resetsAt: number, observedAt: string): Promise<void> {
		await recordQuotaObservation(repos, {
			credential: { provider: "anthropic", env: SERVER_ENV },
			observation: { status: "rejected", utilization: 1, rateLimitType: "five_hour", resetsAt },
			source: "rate_limit_event",
			sourceRunId: null,
			observedAt,
		});
	}

	beforeEach(async () => {
		({ db, repos } = await setupRepos());
		provider = new FakeProvider();
		clock = HELD_AT;
		started = [];
		await rejectUntil(RESETS_AT, "2026-11-22T08:50:31.000Z");
	});
	afterEach(async () => {
		await db.close();
	});

	async function holdRun(): Promise<string> {
		const outcome = await spawnOrHoldRun({
			repos,
			runtimeProvider: provider,
			agentName: "refactor-bot",
			projectId: "prj_xxxxxxxxxxxx",
			prompt: "do the thing",
			trigger: "cli",
			serverEnv: SERVER_ENV,
			now: () => HELD_AT,
		});
		if (outcome.kind !== "held") throw new Error("expected a held run");
		return outcome.run.id;
	}

	function releaser() {
		return createQuotaHoldReleaser({
			repos,
			runtimeProvider: provider,
			bridges: { start: (runId) => started.push(runId) },
			serverEnv: SERVER_ENV,
			now: () => clock,
		});
	}

	async function kinds(runId: string): Promise<string[]> {
		return (await repos.events.listByRun(runId)).map((e) => e.kind);
	}

	test("leaves a held run alone before its release time", async () => {
		const runId = await holdRun();
		clock = BEFORE_RELEASE;

		await releaser().tick();

		expect(provider.calls).toEqual([]);
		expect((await repos.runs.require(runId)).state).toBe("queued");
	});

	test("launches the held run itself after the release time", async () => {
		const runId = await holdRun();
		clock = AFTER_RELEASE;

		await releaser().tick();

		const row = await repos.runs.require(runId);
		expect(row.sandboxRunId).not.toBeNull();
		expect(row.trigger).toBe("cli");
		expect(started).toEqual([runId]);
		expect(await kinds(runId)).toContain(QUOTA_HOLD_EVENTS.released);
		expect((await repos.runs.listAll()).length).toBe(1);
	});

	test("launches on the provider, model and caps the held row froze", async () => {
		await repos.agents.upsert({
			name: "refactor-bot",
			renderedJson: makeAgentJson({ frontmatter: { model: "claude-sonnet-5-5", maxCostUsd: 5 } }),
		});
		const runId = await holdRun();
		await repos.agents.upsert({
			name: "refactor-bot",
			renderedJson: makeAgentJson({ frontmatter: { model: "claude-opus-5-5", maxCostUsd: 50 } }),
		});
		clock = AFTER_RELEASE;

		await releaser().tick();

		const dispatch = provider.calls.find((c) => c.path.endsWith("/runs"));
		if (dispatch === undefined) throw new Error("the held run was not launched");
		const { frontmatter } = (dispatch.body as { metadata: { frontmatter: unknown } }).metadata;
		expect(frontmatter).toMatchObject({ model: "claude-sonnet-5-5", maxCostUsd: 5 });
		expect((await repos.runs.require(runId)).model).toBe("claude-sonnet-5-5");
	});

	test("launches it only once across ticks", async () => {
		await holdRun();
		clock = AFTER_RELEASE;
		const r = releaser();

		await r.tick();
		await r.tick();

		expect(started.length).toBe(1);
	});

	test("holds the run again when the window moved to a later reset", async () => {
		const runId = await holdRun();
		const laterReset = RESETS_AT + 3600;
		await rejectUntil(laterReset, "2026-11-22T09:10:30.000Z");
		clock = AFTER_RELEASE;

		await releaser().tick();

		expect(provider.calls).toEqual([]);
		const helds = (await repos.events.listByRun(runId)).filter(
			(e) => e.kind === QUOTA_HOLD_EVENTS.held,
		);
		expect(helds.at(-1)?.payloadJson).toMatchObject({ resetsAt: laterReset });
		expect((await repos.runs.require(runId)).state).toBe("queued");
	});

	test("never launches a held run the operator cancelled", async () => {
		const runId = await holdRun();
		await repos.runs.finalize(runId, "cancelled", HELD_AT);
		clock = AFTER_RELEASE;

		await releaser().tick();

		expect(provider.calls).toEqual([]);
		expect(started).toEqual([]);
	});

	test("fails a release the control plane stopped in the middle of", async () => {
		const runId = await holdRun();
		await repos.events.append({
			runId,
			sandboxEventSeq: 99,
			ts: HELD_AT.toISOString(),
			kind: QUOTA_HOLD_EVENTS.releasing,
			stream: "system",
			payload: {},
		});
		clock = AFTER_RELEASE;

		await releaser().tick();

		expect(provider.calls).toEqual([]);
		const row = await repos.runs.require(runId);
		expect(row.state).toBe("failed");
		expect(row.failureReason).toBe("never_started");
		expect(await kinds(runId)).toContain(QUOTA_HOLD_EVENTS.releaseFailed);
	});

	test("ignores a queued run that was never held", async () => {
		const run = await repos.runs.create({
			agentName: "refactor-bot",
			projectId: "prj_xxxxxxxxxxxx",
			prompt: "mid-spawn",
			trigger: "manual",
			renderedAgentJson: {},
		});
		clock = AFTER_RELEASE;

		await releaser().tick();

		expect((await repos.runs.require(run.id)).state).toBe("queued");
		expect(await kinds(run.id)).toEqual([]);
	});
});

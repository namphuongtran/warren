/**
 * Held dispatches (namphuongtran/warren#30): an opt-in dispatch the provider
 * quota guard refuses is created `queued` with no workload, and launched as
 * the same row once the window reopens.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { QUOTA_HOLD_EVENTS } from "../../core/wire.ts";
import type { WarrenDb } from "../../db/client.ts";
import type { Repos } from "../../db/repos/index.ts";
import { FakeProvider } from "../../runtime/fake/fake-provider.ts";
import { HeldRunNotPendingError } from "../quota/hold.ts";
import { ProviderQuotaExhaustedError, recordQuotaObservation } from "../quota/state.ts";
import { launchHeldRun, spawnOrHoldRun } from "./index.ts";
import { setupRepos } from "./test-helpers.ts";
import type { SpawnRunInput } from "./types.ts";

const RESETS_AT = 1795338600;
const SECOND_DISPATCH = new Date("2026-11-22T08:50:43.000Z");
const AFTER_RESET = new Date((RESETS_AT + 61) * 1000);
const SERVER_ENV = { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-dispatch-secret" };

describe("held dispatches", () => {
	let db: WarrenDb;
	let repos: Repos;
	let provider: FakeProvider;

	beforeEach(async () => {
		({ db, repos } = await setupRepos());
		provider = new FakeProvider();
		await recordQuotaObservation(repos, {
			credential: { provider: "anthropic", env: SERVER_ENV },
			observation: {
				status: "rejected",
				utilization: 1,
				rateLimitType: "five_hour",
				resetsAt: RESETS_AT,
			},
			source: "rate_limit_event",
			sourceRunId: "run_jy2cxd7cmg9f",
			observedAt: "2026-11-22T08:50:31.000Z",
		});
	});
	afterEach(async () => {
		await db.close();
	});

	function input(now: Date, extra: Partial<SpawnRunInput> = {}): SpawnRunInput {
		return {
			repos,
			runtimeProvider: provider,
			agentName: "refactor-bot",
			projectId: "prj_xxxxxxxxxxxx",
			prompt: "do the thing",
			serverEnv: SERVER_ENV,
			now: () => now,
			...extra,
		};
	}

	describe("spawnOrHoldRun", () => {
		test("holds a refused dispatch as a queued run with no workload", async () => {
			const outcome = await spawnOrHoldRun(input(SECOND_DISPATCH, { maxCostUsdOverride: 4 }));

			if (outcome.kind !== "held") throw new Error(`expected held, got ${outcome.kind}`);
			expect(outcome.run.state).toBe("queued");
			expect(outcome.run.sandboxRunId).toBeNull();
			expect(outcome.hold.reason).toBe("provider_quota_exhausted");
			expect(outcome.hold.resetsAt).toBe(RESETS_AT);
			const releaseAt = Date.parse(outcome.hold.releaseAt) / 1000;
			expect(releaseAt).toBeGreaterThanOrEqual(RESETS_AT + 60);
			expect(releaseAt).toBeLessThan(RESETS_AT + 180);
			expect(provider.calls).toEqual([]);
			const events = await repos.events.listByRun(outcome.run.id);
			const held = events.find((e) => e.kind === QUOTA_HOLD_EVENTS.held);
			expect(held?.payloadJson).toMatchObject({
				resetsAt: RESETS_AT,
				request: { agentName: "refactor-bot", prompt: "do the thing", maxCostUsdOverride: 4 },
			});
			expect(JSON.stringify(events)).not.toContain("sk-ant-oat01");
		});

		test("dispatches straight away while the window is open", async () => {
			const outcome = await spawnOrHoldRun(input(AFTER_RESET));

			expect(outcome.kind).toBe("dispatched");
			expect(provider.calls.length).toBeGreaterThan(0);
		});
	});

	async function held(): Promise<string> {
		const outcome = await spawnOrHoldRun(input(SECOND_DISPATCH));
		if (outcome.kind !== "held") throw new Error("expected a held run");
		return outcome.run.id;
	}

	describe("launchHeldRun", () => {
		test("launches the held row itself after the reset", async () => {
			const runId = await held();

			const result = await launchHeldRun(input(AFTER_RESET), runId);

			expect(result.run.id).toBe(runId);
			expect(result.run.sandboxRunId).not.toBeNull();
			expect((await repos.runs.listAll()).map((r) => r.id)).toEqual([runId]);
		});

		test("leaves the row held while the window is still spent", async () => {
			const runId = await held();

			const refused = await launchHeldRun(input(SECOND_DISPATCH), runId).catch((e: unknown) => e);

			expect(refused).toBeInstanceOf(ProviderQuotaExhaustedError);
			const row = await repos.runs.require(runId);
			expect(row.state).toBe("queued");
			expect(provider.calls).toEqual([]);
		});

		test("refuses a held run the operator cancelled", async () => {
			const runId = await held();
			await repos.runs.finalize(runId, "cancelled", SECOND_DISPATCH);

			const refused = await launchHeldRun(input(AFTER_RESET), runId).catch((e: unknown) => e);

			expect(refused).toBeInstanceOf(HeldRunNotPendingError);
			expect(provider.calls).toEqual([]);
		});

		test("fails the row never_started when the dispatch cannot be prepared", async () => {
			const runId = await held();

			await launchHeldRun(input(AFTER_RESET, { agentName: "deleted-agent" }), runId).catch(
				() => {},
			);

			const row = await repos.runs.require(runId);
			expect(row.state).toBe("failed");
			expect(row.failureReason).toBe("never_started");
		});

		test("stops when the operator cancels during the clone refresh", async () => {
			const runId = await held();
			const cancelMidRefresh = async (args: { id: string }) => {
				await repos.runs.finalize(runId, "cancelled", AFTER_RESET);
				return {
					project: await repos.projects.require(args.id),
					headSha: "f".repeat(40),
					ref: "main",
				};
			};
			const launch = input(AFTER_RESET, {
				projectsConfig: { root: "/data/projects", gitBinary: "git" },
				projectSpawn: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
				refreshProjectFn: cancelMidRefresh as unknown as SpawnRunInput["refreshProjectFn"],
			});

			const refused = await launchHeldRun(launch, runId).catch((e: unknown) => e);

			expect(refused).toBeInstanceOf(HeldRunNotPendingError);
			expect(provider.calls).toEqual([]);
			expect((await repos.runs.require(runId)).state).toBe("cancelled");
		});
	});
});

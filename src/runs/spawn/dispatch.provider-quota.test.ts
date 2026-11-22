/**
 * The provider-quota dispatch guard (namphuongtran/warren#30). `spawnRun` is
 * the one dispatch path every caller and every runtime shares, so the guard
 * lives there: while the credential's usage window is rejected, a dispatch is
 * refused before any run row or workload exists.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { WarrenDb } from "../../db/client.ts";
import type { Repos } from "../../db/repos/index.ts";
import { FakeProvider } from "../../runtime/fake/fake-provider.ts";
import { ProviderQuotaExhaustedError, recordQuotaObservation } from "../quota/state.ts";
import { spawnRun } from "./index.ts";
import { setupRepos } from "./test-helpers.ts";

const RESETS_AT = 1795338600;
const SECOND_DISPATCH = new Date("2026-11-22T08:50:43.000Z");
const AFTER_RESET = new Date((RESETS_AT + 1) * 1000);
const SERVER_ENV = { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-dispatch-secret" };

describe("spawnRun: provider quota guard", () => {
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

	function dispatch(now: Date, extra: { force?: boolean; providerOverride?: string } = {}) {
		return spawnRun({
			repos,
			runtimeProvider: provider,
			agentName: "refactor-bot",
			projectId: "prj_xxxxxxxxxxxx",
			prompt: "do the thing",
			serverEnv: SERVER_ENV,
			now: () => now,
			...extra,
		});
	}

	test("refuses before any run row or workload exists", async () => {
		const refused = await dispatch(SECOND_DISPATCH).then(
			() => null,
			(err: unknown) => err,
		);

		expect(refused).toBeInstanceOf(ProviderQuotaExhaustedError);
		expect((refused as ProviderQuotaExhaustedError).retryAfterSeconds).toBe(1157);
		expect(await repos.runs.listAll()).toEqual([]);
		expect(provider.calls).toEqual([]);
	});

	test("dispatches with force: true while the window is rejected", async () => {
		const result = await dispatch(SECOND_DISPATCH, { force: true });

		expect(result.run.state).toBe("queued");
	});

	test("dispatches again after the reset", async () => {
		const result = await dispatch(AFTER_RESET);

		expect(result.run.state).toBe("queued");
	});

	test("dispatches a run that authenticates with another provider", async () => {
		const result = await dispatch(SECOND_DISPATCH, { providerOverride: "openrouter" });

		expect(result.run.provider).toBe("openrouter");
	});
});

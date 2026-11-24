/**
 * The provider-quota utilization threshold at dispatch (namphuongtran/warren#30).
 * Off by default. The project's `admission.maxProviderUtilization` wins over the
 * deployment default `WARREN_PROVIDER_QUOTA_MAX_UTILIZATION`. At or past the
 * threshold a dispatch is refused like a spent window, until the reset.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { WarrenDb } from "../../db/client.ts";
import type { Repos } from "../../db/repos/index.ts";
import { FakeProvider } from "../../runtime/fake/fake-provider.ts";
import { createWarrenConfigCache } from "../../warren-config/cache.ts";
import {
	PROVIDER_QUOTA_MAX_UTILIZATION_ENV,
	ProviderQuotaExhaustedError,
	recordQuotaObservation,
	resolveMaxUtilization,
} from "../quota/state.ts";
import { spawnRun } from "./index.ts";
import { setupRepos } from "./test-helpers.ts";

const RESETS_AT = 1795338600;
const NOW = new Date("2026-11-22T08:45:00.000Z");
const TOKEN_ENV = { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-threshold-secret" };

const projectThreshold = (maxProviderUtilization: number) =>
	createWarrenConfigCache({
		load: async () => ({
			triggers: null,
			defaults: { admission: { maxProviderUtilization } },
			prTemplate: null,
			sourceFile: null,
			errors: [],
			warnings: [],
		}),
	});

describe("spawnRun: provider quota utilization threshold", () => {
	let db: WarrenDb;
	let repos: Repos;

	beforeEach(async () => {
		({ db, repos } = await setupRepos());
		await recordQuotaObservation(repos, {
			credential: { provider: "anthropic", env: TOKEN_ENV },
			observation: {
				status: "allowed_warning",
				utilization: 0.95,
				rateLimitType: "five_hour",
				resetsAt: RESETS_AT,
			},
			source: "rate_limit_event",
			sourceRunId: "run_jy2cxd7cmg9f",
			observedAt: "2026-11-22T08:42:00.000Z",
		});
	});
	afterEach(async () => {
		await db.close();
	});

	function dispatch(env: Record<string, string>, projectMax?: number) {
		return spawnRun({
			repos,
			runtimeProvider: new FakeProvider(),
			agentName: "refactor-bot",
			projectId: "prj_xxxxxxxxxxxx",
			prompt: "do the thing",
			serverEnv: { ...TOKEN_ENV, ...env },
			now: () => NOW,
			...(projectMax !== undefined ? { warrenConfigs: projectThreshold(projectMax) } : {}),
		});
	}

	test("dispatches a 95%-used window when no threshold is set", async () => {
		const result = await dispatch({});

		expect(result.run.state).toBe("queued");
	});

	test("refuses at the deployment threshold, before any run row exists", async () => {
		const refused = await dispatch({ [PROVIDER_QUOTA_MAX_UTILIZATION_ENV]: "0.9" }).then(
			() => null,
			(err: unknown) => err,
		);

		expect(refused).toBeInstanceOf(ProviderQuotaExhaustedError);
		expect((refused as ProviderQuotaExhaustedError).resetsAt).toBe(RESETS_AT);
		expect(await repos.runs.listAll()).toEqual([]);
	});

	test("lets the project threshold override the deployment one", async () => {
		const result = await dispatch({ [PROVIDER_QUOTA_MAX_UTILIZATION_ENV]: "0.9" }, 0.99);

		expect(result.run.state).toBe("queued");
	});
});

describe("resolveMaxUtilization", () => {
	test("prefers the project value, then a valid env share, else off", () => {
		const env = (value: string) => ({ [PROVIDER_QUOTA_MAX_UTILIZATION_ENV]: value });

		expect(resolveMaxUtilization(0.8, env("0.9"))).toBe(0.8);
		expect(resolveMaxUtilization(undefined, env("0.9"))).toBe(0.9);
		expect(resolveMaxUtilization(undefined, env("1"))).toBe(1);
		expect(resolveMaxUtilization(undefined, {})).toBeUndefined();
		for (const bad of ["", "0", "-0.5", "1.5", "90", "ninety"]) {
			expect(resolveMaxUtilization(undefined, env(bad))).toBeUndefined();
		}
	});
});

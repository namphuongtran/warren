/**
 * The held-run view for the runs list (namphuongtran/warren#30): which runs
 * on a page are waiting for a provider quota window, and until when.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { QUOTA_HOLD_EVENTS } from "../../core/wire.ts";
import type { WarrenDb } from "../../db/client.ts";
import type { Repos } from "../../db/repos/index.ts";
import { FakeProvider } from "../../runtime/fake/fake-provider.ts";
import { spawnOrHoldRun } from "../spawn/index.ts";
import { setupRepos } from "../spawn/test-helpers.ts";
import { appendRunSystemEvent } from "../stream/system-event.ts";
import { currentQuotaHolds } from "./hold-view.ts";
import { recordQuotaObservation } from "./state.ts";

const RESETS_AT = 1795338600;
const HELD_AT = new Date("2026-11-22T08:50:43.000Z");
const SERVER_ENV = { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-dispatch-secret" };

describe("currentQuotaHolds", () => {
	let db: WarrenDb;
	let repos: Repos;

	beforeEach(async () => {
		({ db, repos } = await setupRepos());
		await recordQuotaObservation(repos, {
			credential: { provider: "anthropic", env: SERVER_ENV },
			observation: {
				status: "rejected",
				utilization: 1,
				rateLimitType: "five_hour",
				resetsAt: RESETS_AT,
			},
			source: "rate_limit_event",
			sourceRunId: null,
			observedAt: "2026-11-22T08:50:31.000Z",
		});
	});
	afterEach(async () => {
		await db.close();
	});

	async function dispatch(force: boolean): Promise<string> {
		const outcome = await spawnOrHoldRun({
			repos,
			runtimeProvider: new FakeProvider(),
			agentName: "refactor-bot",
			projectId: "prj_xxxxxxxxxxxx",
			prompt: "do the thing",
			serverEnv: SERVER_ENV,
			now: () => HELD_AT,
			force,
		});
		return outcome.kind === "held" ? outcome.run.id : outcome.result.run.id;
	}

	async function holdsFor(ids: readonly string[]) {
		const runs = await Promise.all(ids.map((id) => repos.runs.require(id)));
		return currentQuotaHolds(repos, runs);
	}

	test("returns the hold of a waiting run, and nothing for a launched one", async () => {
		const held = await dispatch(false);
		const launched = await dispatch(true);

		const holds = await holdsFor([held, launched]);

		const hold = holds.get(held);
		expect(hold).toMatchObject({ reason: "provider_quota_exhausted", resetsAt: RESETS_AT });
		// The reset plus the release delay and jitter.
		const releaseSeconds = Date.parse(hold?.releaseAt ?? "") / 1000;
		expect(releaseSeconds).toBeGreaterThanOrEqual(RESETS_AT + 60);
		expect(releaseSeconds).toBeLessThan(RESETS_AT + 180);
		expect(holds.has(launched)).toBe(false);
	});

	test("drops a hold once its release has started", async () => {
		const held = await dispatch(false);
		await appendRunSystemEvent(repos, undefined, {
			runId: held,
			kind: QUOTA_HOLD_EVENTS.releasing,
			payload: {},
			ts: new Date((RESETS_AT + 61) * 1000).toISOString(),
		});

		expect((await holdsFor([held])).size).toBe(0);
	});

	test("drops a hold whose run was cancelled", async () => {
		const held = await dispatch(false);
		await repos.runs.finalize(held, "cancelled", HELD_AT);

		expect((await holdsFor([held])).size).toBe(0);
	});
});

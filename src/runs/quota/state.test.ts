import { afterEach, describe, expect, test } from "bun:test";
import { createRepos, type Repos } from "../../db/repos/index.ts";
import { type TestDbHandle, withDb } from "../../db/testing.ts";
import { observeQuota } from "../../runtime/adapters/index.ts";
import { claudeEvents } from "../reap/quota-test-helpers.ts";
import {
	assertProviderQuotaOpen,
	listProviderQuota,
	ProviderQuotaExhaustedError,
	recordQuotaObservation,
} from "./state.ts";

// The live evidence of namphuongtran/warren#30: the five-hour window was
// rejected at 08:50:31Z and reopened at 09:10:00Z (unix 1795338600).
const RESETS_AT = 1795338600;
const REJECTED_AT = "2026-11-22T08:50:31.000Z";
const SECOND_DISPATCH = new Date("2026-11-22T08:50:43.000Z");
const AFTER_RESET = new Date((RESETS_AT + 1) * 1000);

const OAUTH = "sk-ant-oat01-subscription-secret-value";
const SUBSCRIPTION_ENV = { CLAUDE_CODE_OAUTH_TOKEN: OAUTH };
const anthropic = { provider: "anthropic", env: SUBSCRIPTION_ENV };

let handle: TestDbHandle | undefined;
afterEach(async () => {
	await handle?.close();
	handle = undefined;
});

async function openRepos(): Promise<Repos> {
	handle = await withDb();
	return createRepos(handle.db);
}

/** Replay a recorded claude event log into the quota state, one event per second. */
async function replay(repos: Repos, fixture: string, endAt: string): Promise<void> {
	const events = claudeEvents(fixture);
	const end = Date.parse(endAt);
	for (const [i, event] of events.entries()) {
		const observation = observeQuota(event);
		if (observation === null) continue;
		await recordQuotaObservation(repos, {
			credential: anthropic,
			observation,
			source: "rate_limit_event",
			sourceRunId: "run_jy2cxd7cmg9f",
			observedAt: new Date(end - (events.length - 1 - i) * 1000).toISOString(),
		});
	}
}

async function refusal(promise: Promise<void>): Promise<ProviderQuotaExhaustedError> {
	try {
		await promise;
	} catch (err) {
		if (err instanceof ProviderQuotaExhaustedError) return err;
		throw err;
	}
	throw new Error("expected the dispatch to be refused");
}

describe("provider quota state", () => {
	test("refuses dispatch on a credential whose replayed window is rejected", async () => {
		const repos = await openRepos();
		await replay(repos, "claude-code-quota-mid-run.jsonl", REJECTED_AT);

		const err = await refusal(
			assertProviderQuotaOpen(repos, { credential: anthropic, now: SECOND_DISPATCH }),
		);
		expect(err.code).toBe("provider_quota_exhausted");
		expect(err.reason).toBe("provider_quota_exhausted");
		// 08:50:43Z → 09:10:00Z
		expect(err.retryAfterSeconds).toBe(1157);
	});

	test("dispatches again once resetsAt has passed, with no new report", async () => {
		const repos = await openRepos();
		await replay(repos, "claude-code-quota-mid-run.jsonl", REJECTED_AT);

		await assertProviderQuotaOpen(repos, { credential: anthropic, now: AFTER_RESET });
	});

	test("lets a forced dispatch through a rejected window", async () => {
		const repos = await openRepos();
		await replay(repos, "claude-code-quota-turn-one.jsonl", REJECTED_AT);

		await assertProviderQuotaOpen(repos, {
			credential: anthropic,
			now: SECOND_DISPATCH,
			force: true,
		});
	});

	test("keeps other credentials and other providers open", async () => {
		const repos = await openRepos();
		await replay(repos, "claude-code-quota-turn-one.jsonl", REJECTED_AT);

		const otherToken = { provider: "anthropic", env: { CLAUDE_CODE_OAUTH_TOKEN: "other" } };
		await assertProviderQuotaOpen(repos, { credential: otherToken, now: SECOND_DISPATCH });
		const apiKeyWins = {
			provider: "anthropic",
			env: { ...SUBSCRIPTION_ENV, ANTHROPIC_API_KEY: "sk-ant-api" },
		};
		await assertProviderQuotaOpen(repos, { credential: apiKeyWins, now: SECOND_DISPATCH });
		const openrouter = { provider: "openrouter", env: { OPENROUTER_API_KEY: "sk-or" } };
		await assertProviderQuotaOpen(repos, { credential: openrouter, now: SECOND_DISPATCH });
	});

	test("treats an undeclared provider as anthropic", async () => {
		const repos = await openRepos();
		await replay(repos, "claude-code-quota-turn-one.jsonl", REJECTED_AT);

		const undeclared = { provider: null, env: SUBSCRIPTION_ENV };
		await refusal(assertProviderQuotaOpen(repos, { credential: undeclared, now: SECOND_DISPATCH }));
	});

	test("ignores a report older than the one already stored", async () => {
		const repos = await openRepos();
		await replay(repos, "claude-code-quota-turn-one.jsonl", REJECTED_AT);
		await recordQuotaObservation(repos, {
			credential: anthropic,
			observation: {
				status: "allowed",
				utilization: 0.4,
				rateLimitType: "five_hour",
				resetsAt: RESETS_AT,
			},
			source: "rate_limit_event",
			sourceRunId: "run_late_bridge",
			observedAt: "2026-11-22T08:40:00.000Z",
		});

		await refusal(assertProviderQuotaOpen(repos, { credential: anthropic, now: SECOND_DISPATCH }));
	});

	test("lists the state by a one-way fingerprint, never the token", async () => {
		const repos = await openRepos();
		await replay(repos, "claude-code-quota-mid-run.jsonl", REJECTED_AT);

		const rows = await listProviderQuota(repos, SECOND_DISPATCH);
		expect(rows).toHaveLength(1);
		const [row] = rows;
		expect(row).toMatchObject({
			provider: "anthropic",
			status: "rejected",
			utilization: 1,
			rateLimitType: "five_hour",
			resetsAt: RESETS_AT,
			source: "rate_limit_event",
			sourceRunId: "run_jy2cxd7cmg9f",
			exhausted: true,
			retryAfterSeconds: 1157,
		});
		expect(row?.credentialFingerprint).toMatch(/^[0-9a-f]{16}$/);
		expect(JSON.stringify(rows)).not.toContain(OAUTH);
		expect(JSON.stringify(rows)).not.toContain(OAUTH.slice(-12));
	});
});

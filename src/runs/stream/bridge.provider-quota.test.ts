import { beforeEach, describe, expect, test } from "bun:test";
import { openDatabase } from "../../db/client.ts";
import { createRepos, type Repos } from "../../db/repos/index.ts";
import { RunEventBroker } from "../events.ts";
import { listProviderQuota } from "../quota/state.ts";
import { bridgeRunStream } from "./bridge.ts";
import { claudeResult, evt, makeProvider, source } from "./test-helpers.ts";
import type { StreamEventView } from "./types.ts";

const SBX = "run_zzzzzzzzzzzz";
const RESETS_AT = 1795338600;

/** A claude `rate_limit_event`, as the claude parser persists it. */
function rateLimit(seq: number, status: string, utilization: number, origin?: string) {
	const info = {
		status,
		resetsAt: RESETS_AT,
		rateLimitType: "five_hour",
		unifiedWindows: { five_hour: { utilization, resetsAt: RESETS_AT, status } },
	};
	const event: StreamEventView = evt(SBX, seq, {
		kind: "telemetry",
		stream: "system",
		payload: { type: "rate_limit_event", rate_limit_info: info },
	});
	return origin === undefined ? event : { ...event, origin };
}

const RESULT = claudeResult(SBX, 9, { inputTokens: 1, outputTokens: 1, totalCostUsd: 0.01 });

describe("bridgeRunStream — provider quota (namphuongtran/warren#30)", () => {
	let repos: Repos;

	beforeEach(async () => {
		repos = createRepos(await openDatabase({ path: ":memory:" }));
		await repos.agents.upsert({ name: "claude-code", renderedJson: {} });
	});

	async function bridge(events: StreamEventView[]): Promise<string> {
		const project = await repos.projects.create({
			gitUrl: "https://github.com/x/y.git",
			localPath: "/data/projects/x/y",
			defaultBranch: "main",
		});
		const run = await repos.runs.create({
			agentName: "claude-code",
			projectId: project.id,
			prompt: "p",
			renderedAgentJson: {},
			trigger: "manual",
			sandboxId: "bur_aaaaaaaaaaaa",
			sandboxRunId: SBX,
		});
		await bridgeRunStream({
			runId: run.id,
			sandboxRunId: SBX,
			repos,
			broker: new RunEventBroker(),
			sandboxId: "bur_aaaaaaaaaaaa",
			runtimeProvider: makeProvider(),
			source: source(events),
		});
		return run.id;
	}

	test("records the newest rate_limit_event against the run's credential", async () => {
		const runId = await bridge([
			rateLimit(1, "allowed", 0.87),
			rateLimit(2, "allowed_warning", 0.99),
			rateLimit(3, "rejected", 1),
			RESULT,
		]);

		const rows = await listProviderQuota(repos, new Date((RESETS_AT - 60) * 1000));
		expect(rows).toEqual([
			expect.objectContaining({
				provider: "anthropic",
				status: "rejected",
				utilization: 1,
				resetsAt: RESETS_AT,
				source: "rate_limit_event",
				sourceRunId: runId,
				exhausted: true,
			}),
		]);
	});

	test("ignores a rate_limit_event the agent printed itself", async () => {
		await bridge([rateLimit(1, "rejected", 1, "agent"), RESULT]);

		expect(await listProviderQuota(repos, new Date((RESETS_AT - 60) * 1000))).toEqual([]);
	});
});

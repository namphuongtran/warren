/**
 * namphuongtran/warren#7: a harness that drops the resolved provider/model
 * must say so. A claude-code run dispatched as `openrouter` / `kimi-k3` gets a visible
 * `model_selection_ignored` warning event, and the bridge then records the
 * model claude-code reports in its init envelope. The two halves run
 * together here because the warning is written before the runtime's own
 * events exist: it must not shadow the runtime's seq 1, which carries the
 * init envelope.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { WarrenDb } from "../../db/client.ts";
import type { Repos } from "../../db/repos/index.ts";
import { RunEventBroker } from "../events.ts";
import { bridgeRunStream } from "../stream/bridge.ts";
import {
	claudeResult,
	evt,
	makeProvider as makeStreamProvider,
	source,
} from "../stream/test-helpers.ts";
import { spawnRun } from "./index.ts";
import { MODEL_SELECTION_IGNORED_EVENT_KIND } from "./model-selection.ts";
import { makeAgentJson, makeProvider, makeSandboxClient, setupRepos } from "./test-helpers.ts";

describe("spawnRun: dropped model selection (namphuongtran/warren#7)", () => {
	let db: WarrenDb;
	let repos: Repos;

	beforeEach(async () => {
		({ db, repos } = await setupRepos());
		await repos.agents.upsert({
			name: "claude-code",
			renderedJson: makeAgentJson({
				name: "claude-code",
				frontmatter: { runtime: "claude-code" },
			}),
		});
	});
	afterEach(async () => {
		await db.close();
	});

	async function dispatch(agentName: string, provider: string, model: string): Promise<string> {
		const { client } = makeSandboxClient();
		const result = await spawnRun({
			repos,
			runtimeProvider: makeProvider(client),
			agentName,
			projectId: "prj_xxxxxxxxxxxx",
			prompt: "do the thing",
			providerOverride: provider,
			modelOverride: model,
		});
		return result.run.id;
	}

	async function bridgeInit(runId: string, model: string): Promise<void> {
		const run = await repos.runs.require(runId);
		const sandboxRunId = run.sandboxRunId ?? "";
		await bridgeRunStream({
			runId,
			sandboxRunId,
			repos,
			broker: new RunEventBroker(),
			sandboxId: run.sandboxId ?? "",
			runtimeProvider: makeStreamProvider(),
			source: source([
				evt(sandboxRunId, 1, {
					kind: "state_change",
					stream: "system",
					payload: { type: "system", subtype: "init", model },
				}),
				claudeResult(sandboxRunId, 2, { inputTokens: 1, outputTokens: 1, totalCostUsd: 0 }),
			]),
		});
	}

	async function warnings(runId: string): Promise<Record<string, unknown>[]> {
		const rows = await repos.events.listByRun(runId);
		return rows
			.filter((e) => e.kind === MODEL_SELECTION_IGNORED_EVENT_KIND)
			.map((e) => e.payloadJson as Record<string, unknown>);
	}

	test("warns about an ignored openrouter selection, then records the model claude-code ran", async () => {
		const runId = await dispatch("claude-code", "openrouter", "moonshotai/kimi-k3");

		const warned = await warnings(runId);
		expect(warned).toHaveLength(1);
		expect(warned[0]).toMatchObject({
			provider: "openrouter",
			model: "moonshotai/kimi-k3",
		});
		expect(String(warned[0]?.reason)).toContain("Anthropic");

		await bridgeInit(runId, "claude-sonnet-5-5");
		expect((await repos.runs.require(runId)).model).toBe("claude-sonnet-5-5");
	});

	test("records an anthropic selection with no warning", async () => {
		const runId = await dispatch("claude-code", "anthropic", "claude-opus-5-5");
		expect(await warnings(runId)).toHaveLength(0);

		await bridgeInit(runId, "claude-opus-5-5");
		expect((await repos.runs.require(runId)).model).toBe("claude-opus-5-5");
	});

	test("does not warn for a harness that honors the provider", async () => {
		const runId = await dispatch("refactor-bot", "openrouter", "moonshotai/kimi-k3");
		expect(await warnings(runId)).toHaveLength(0);
	});
});

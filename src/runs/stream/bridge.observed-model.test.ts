import { beforeEach, describe, expect, test } from "bun:test";
import { openDatabase } from "../../db/client.ts";
import { createRepos, type Repos } from "../../db/repos/index.ts";
import { RunEventBroker } from "../events.ts";
import { bridgeRunStream } from "./bridge.ts";
import { claudeResult, evt, makeProvider, source } from "./test-helpers.ts";
import type { StreamEventView } from "./types.ts";

const SBX = "run_zzzzzzzzzzzz";

/** claude-code's first stream-json line, as the claude parser persists it. */
function claudeInit(seq: number, model: string, origin?: string): StreamEventView {
	return {
		...evt(SBX, seq, {
			kind: "state_change",
			stream: "system",
			payload: { type: "system", subtype: "init", session_id: "s-1", model, tools: [] },
		}),
		...(origin !== undefined ? { origin } : {}),
	};
}

const RESULT = claudeResult(SBX, 9, { inputTokens: 1, outputTokens: 1, totalCostUsd: 0.01 });

describe("bridgeRunStream — observed model (namphuongtran/warren#7)", () => {
	let repos: Repos;

	beforeEach(async () => {
		repos = createRepos(await openDatabase({ path: ":memory:" }));
		await repos.agents.upsert({ name: "claude-code", renderedJson: {} });
	});

	async function dispatchedRun(provider: string, model: string): Promise<string> {
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
			provider,
			model,
			sandboxId: "bur_aaaaaaaaaaaa",
			sandboxRunId: SBX,
		});
		return run.id;
	}

	async function bridge(runId: string, events: StreamEventView[]): Promise<void> {
		await bridgeRunStream({
			runId,
			sandboxRunId: SBX,
			repos,
			broker: new RunEventBroker(),
			sandboxId: "bur_aaaaaaaaaaaa",
			runtimeProvider: makeProvider(),
			source: source(events),
		});
	}

	test("records the init event's model over a dropped non-anthropic declaration", async () => {
		const runId = await dispatchedRun("openrouter", "moonshotai/kimi-k3");
		await bridge(runId, [claudeInit(1, "claude-sonnet-5-5"), RESULT]);
		expect((await repos.runs.require(runId)).model).toBe("claude-sonnet-5-5");
	});

	test("keeps an anthropic run's model when the harness ran what it was asked to", async () => {
		const runId = await dispatchedRun("anthropic", "claude-opus-5-5");
		await bridge(runId, [claudeInit(1, "claude-opus-5-5"), RESULT]);
		expect((await repos.runs.require(runId)).model).toBe("claude-opus-5-5");
	});

	test("keeps the declared model when no envelope names a usable one", async () => {
		const runId = await dispatchedRun("anthropic", "claude-opus-5-5");
		const systemEvent = (seq: number, payload: Record<string, unknown>): StreamEventView =>
			evt(SBX, seq, { kind: "state_change", stream: "system", payload });
		await bridge(runId, [
			systemEvent(1, { type: "system", subtype: "init", model: 42 }),
			systemEvent(2, { type: "system", subtype: "init", model: "   " }),
			systemEvent(3, { type: "system", subtype: "compact_boundary", model: "claude-haiku-5-5" }),
			systemEvent(4, { type: "assistant", subtype: "init", model: "claude-haiku-5-5" }),
			evt(SBX, 5, { kind: "text", stream: "stdout", payload: { subtype: "init", model: "x" } }),
			RESULT,
		]);
		expect((await repos.runs.require(runId)).model).toBe("claude-opus-5-5");
	});

	test("ignores an init line the agent printed itself", async () => {
		const runId = await dispatchedRun("anthropic", "claude-opus-5-5");
		await bridge(runId, [claudeInit(1, "claude-haiku-5-5", "agent"), RESULT]);
		expect((await repos.runs.require(runId)).model).toBe("claude-opus-5-5");
	});
});

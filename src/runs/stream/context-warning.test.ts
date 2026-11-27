import { beforeEach, describe, expect, test } from "bun:test";
import { openDatabase } from "../../db/client.ts";
import { createRepos, type Repos } from "../../db/repos/index.ts";
import { RunEventBroker } from "../events.ts";
import { bridgeRunStream } from "./bridge.ts";
import { contextWarningFractionFromEnv } from "./context-warning.ts";
import { makeProvider, seedBridgeRun, source } from "./test-helpers.ts";
import type { BridgeRunStreamInput, StreamEventView } from "./types.ts";

function at(seq: number): Date {
	return new Date(2026, 10, 27, 12, 0, seq);
}

/** Pi `turn_end` naming the model and the request's total tokens. */
function turnEnd(seq: number, totalTokens: number): StreamEventView {
	return {
		seq,
		kind: "state_change",
		stream: "system",
		payload: {
			type: "turn_end",
			message: { model: "claude-sonnet-5-5", usage: { totalTokens, input: totalTokens } },
		},
		ts: at(seq),
	};
}

/** claude-code `assistant_usage` telemetry, as its parser emits it. */
function assistantUsage(seq: number, cacheRead: number): StreamEventView {
	return {
		seq,
		kind: "telemetry",
		stream: "system",
		payload: {
			type: "assistant_usage",
			message: {
				id: `msg_${seq}`,
				model: "claude-sonnet-5-5",
				usage: { input_tokens: 10, cache_read_input_tokens: cacheRead, output_tokens: 90 },
			},
		},
		ts: at(seq),
	};
}

describe("bridgeRunStream — context-window warning (namphuongtran/warren#20)", () => {
	let repos: Repos;
	let broker: RunEventBroker;
	let runId: string;
	let sandboxRunId: string;
	let steers: string[];

	beforeEach(async () => {
		repos = createRepos(await openDatabase({ path: ":memory:" }));
		broker = new RunEventBroker();
		steers = [];
	});

	async function seed(renderedAgentJson: unknown = {}): Promise<void> {
		const ids = await seedBridgeRun(repos, { renderedAgentJson });
		runId = ids.runId;
		sandboxRunId = ids.sandboxRunId;
	}

	function bridge(
		events: StreamEventView[],
		extra: Partial<BridgeRunStreamInput> = {},
	): ReturnType<typeof bridgeRunStream> {
		return bridgeRunStream({
			runId,
			sandboxRunId,
			repos,
			broker,
			sandboxId: "bur_aaaaaaaaaaaa",
			runtimeProvider: makeProvider(),
			warningSteer: async (body) => {
				steers.push(body);
			},
			source: source(events),
			...extra,
		});
	}

	async function warnings(): Promise<unknown[]> {
		const events = await repos.events.listByRun(runId);
		return events.filter((e) => e.kind === "context.warning").map((e) => e.payloadJson);
	}

	test("emits exactly one context.warning when a pi run crosses the threshold", async () => {
		await seed();
		// 200k window, default 80% threshold: 100k → 165k crosses, 170k stays past it.
		const result = await bridge([turnEnd(1, 100_000), turnEnd(2, 165_000), turnEnd(3, 170_000)]);

		expect(result.terminalDetected).toBeUndefined();
		expect(await warnings()).toEqual([
			{
				tokensUsed: 165_000,
				windowTokens: 200_000,
				thresholdTokens: 160_000,
				fraction: 0.8,
				model: "claude-sonnet-5-5",
			},
		]);
	});

	test("emits exactly one context.warning when a claude-code run crosses the threshold", async () => {
		await seed();
		await bridge([
			assistantUsage(1, 120_000),
			assistantUsage(2, 159_950),
			assistantUsage(3, 175_000),
		]);

		expect(await warnings()).toEqual([
			{
				tokensUsed: 160_050,
				windowTokens: 200_000,
				thresholdTokens: 160_000,
				fraction: 0.8,
				model: "claude-sonnet-5-5",
			},
		]);
	});

	test("persists one usage row when claude-code repeats a request's usage on each block line", async () => {
		await seed();
		const block: StreamEventView = {
			seq: 2,
			kind: "text",
			stream: "stdout",
			payload: { text: "checking" },
			ts: at(2),
		};
		await bridge([assistantUsage(1, 120_000), block, { ...assistantUsage(1, 120_000), seq: 3 }]);

		const rows = await repos.events.listByRun(runId);
		expect(rows.map((e) => e.kind)).toEqual(["telemetry", "text"]);
	});

	test("emits no warning while the context stays under the threshold", async () => {
		await seed({ frontmatter: { steering: "mid-run" } });
		await bridge([turnEnd(1, 100_000), turnEnd(2, 159_999)]);

		expect(await warnings()).toHaveLength(0);
		expect(steers).toHaveLength(0);
	});

	test("steers a mid-run harness exactly once at the warning", async () => {
		await seed({ frontmatter: { steering: "mid-run" } });
		await bridge([turnEnd(1, 165_000), turnEnd(2, 170_000), turnEnd(3, 190_000)]);

		expect(await warnings()).toHaveLength(1);
		expect(steers).toEqual([
			"Your context window is 83% full (165,000 of 200,000 tokens). " +
				"Write .warren/handoff.json and your report now, then continue or stop.",
		]);
	});

	test("does not steer a spawn-only harness such as claude-code", async () => {
		await seed({ frontmatter: { steering: "spawn-only" } });
		await bridge([assistantUsage(1, 175_000)]);

		expect(await warnings()).toHaveLength(1);
		expect(steers).toHaveLength(0);
	});

	test("skips a second warning when a resumed bridge already warned", async () => {
		await seed({ frontmatter: { steering: "mid-run" } });
		await bridge([turnEnd(1, 165_000)]);
		// The warning row took seq 2, so the resumed stream continues at seq 3.
		await bridge([turnEnd(1, 165_000), turnEnd(3, 180_000)]);

		expect(await warnings()).toHaveLength(1);
		expect(steers).toHaveLength(1);
	});
});

describe("contextWarningFractionFromEnv", () => {
	test("defaults to 80% when unset", () => {
		expect(contextWarningFractionFromEnv({})).toBe(0.8);
	});

	test("reads a fraction between 0 and 1", () => {
		expect(contextWarningFractionFromEnv({ WARREN_CONTEXT_WARNING_FRACTION: "0.7" })).toBe(0.7);
	});

	test("disables the warning at 0", () => {
		expect(contextWarningFractionFromEnv({ WARREN_CONTEXT_WARNING_FRACTION: "0" })).toBeNull();
	});

	test("falls back to 80% on a value outside (0, 1)", () => {
		expect(contextWarningFractionFromEnv({ WARREN_CONTEXT_WARNING_FRACTION: "1.5" })).toBe(0.8);
		expect(contextWarningFractionFromEnv({ WARREN_CONTEXT_WARNING_FRACTION: "x" })).toBe(0.8);
	});
});

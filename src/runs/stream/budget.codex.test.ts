/**
 * Codex runs through warren's existing usage, spend-cap, and provider-error
 * paths (namphuongtran/warren#17). The Codex parser normalizes its terminal turn onto the shared
 * `result` envelope, so these tests feed real parser output into the
 * unchanged bridge and classifiers rather than hand-built envelopes.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { openDatabase } from "../../db/client.ts";
import { createRepos, type Repos } from "../../db/repos/index.ts";
import { adapterFor } from "../../runtime/adapters/index.ts";
import { RunEventBroker } from "../events.ts";
import { classifyTerminalProviderError } from "../reap/provider-error.ts";
import { classifyProviderError } from "../retry/provider-retry.ts";
import { aggregateUsageFromEvents } from "../usage-aggregate.ts";
import { bridgeRunStream } from "./bridge.ts";
import { makeProvider, seedBridgeRun, source } from "./test-helpers.ts";
import type { StreamEventView } from "./types.ts";

const GOLDEN = join(import.meta.dir, "../../runtime/adapters/parsers/__golden__");
const FRONTMATTER = { provider: "openai", model: "gpt-5.3-codex" };

/** Parse Codex stdout lines the way the drive loop does, as a persisted stream. */
function codexStream(lines: readonly string[]): StreamEventView[] {
	const codex = adapterFor("codex");
	return lines
		.flatMap((line) => codex.parseEvents?.(line, { frontmatter: FRONTMATTER }) ?? [])
		.map((event, i) => ({
			seq: i + 1,
			kind: event.kind,
			stream: event.stream,
			payload: event.payload,
			ts: new Date(2026, 10, 21, 12, 0, i),
		}));
}

function fixture(name: string): string[] {
	return readFileSync(join(GOLDEN, `${name}.jsonl`), "utf8").split("\n");
}

/** One Codex turn that spends $3.50: 2M uncached input tokens at $1.75/M. */
const EXPENSIVE_TURN = JSON.stringify({
	type: "turn.completed",
	usage: { input_tokens: 2_000_000, cached_input_tokens: 0, output_tokens: 0 },
});

describe("Codex usage through the shared aggregator", () => {
	test("a recorded tool run yields priced tokens with the cached share split out", () => {
		expect(aggregateUsageFromEvents(codexStream(fixture("codex-v0.171.0-tools")))).toEqual({
			costUsd: 0.00653765,
			tokensInput: 315,
			tokensOutput: 122,
			tokensCacheRead: 24448,
			tokensCacheWrite: 0,
		});
	});
});

describe("bridgeRunStream on a Codex run", () => {
	let repos: Repos;
	let runId: string;
	let sandboxRunId: string;

	beforeEach(async () => {
		repos = createRepos(await openDatabase({ path: ":memory:" }));
		({ runId, sandboxRunId } = await seedBridgeRun(repos));
	});

	async function bridge(lines: readonly string[], costCapUsd: number) {
		const cancels: string[] = [];
		const result = await bridgeRunStream({
			runId,
			sandboxRunId,
			repos,
			broker: new RunEventBroker(),
			sandboxId: "bur_aaaaaaaaaaaa",
			runtimeProvider: makeProvider(),
			costCapUsd,
			cancelBurrowRun: async (reason) => {
				cancels.push(reason);
			},
			source: source(codexStream(lines)),
		});
		return { result, cancels };
	}

	test("trips the spend cap and persists the Codex cost", async () => {
		const { result, cancels } = await bridge(['{"type":"turn.started"}', EXPENSIVE_TURN], 1);
		expect(result.terminalDetected).toEqual({ outcome: "cancelled" });
		expect(cancels[0]).toContain("spend cap exceeded");
		const events = await repos.events.listByRun(runId);
		expect(events.some((e) => e.kind === "budget.exceeded")).toBe(true);
		expect((await repos.runs.require(runId)).costUsd).toBeCloseTo(3.5, 10);
	});

	test("under the cap, the terminal result succeeds the run and records its cost", async () => {
		const { result, cancels } = await bridge(fixture("codex-v0.171.0-tools"), 5);
		expect(cancels).toEqual([]);
		expect(result.terminalDetected).toEqual({ outcome: "succeeded" });
		expect((await repos.runs.require(runId)).costUsd).toBeCloseTo(0.00653765, 10);
	});
});

describe("Codex errors through the provider-error net and retry classifier", () => {
	test("a failed turn is captured with its provider, model, and HTTP status", () => {
		const signal = classifyTerminalProviderError(
			codexStream(fixture("codex-v0.171.0-auth-failure")),
			{ envPattern: null },
		);
		expect(signal).toMatchObject({ provider: "openai", model: "gpt-5.3-codex", httpStatus: 401 });
		expect(signal?.message).toContain("Incorrect API key");
	});

	test("a reconnect notice followed by a successful turn records no provider error", () => {
		const lines = [
			JSON.stringify({ type: "error", message: "Reconnecting... 1/5 (stream disconnected)" }),
			...fixture("codex-v0.171.0-tools"),
		];
		expect(classifyTerminalProviderError(codexStream(lines), { envPattern: null })).toBeNull();
	});

	test("auth, rate limit, and context overflow never retry; a dropped stream does", () => {
		expect(classifyProviderError("unexpected status 401 Unauthorized", 401)).toBe("durable");
		expect(classifyProviderError("You've hit your usage limit. Try again later.")).toBe("durable");
		expect(
			classifyProviderError(
				"Codex ran out of room in the model's context window. Start a new thread.",
			),
		).toBe("durable");
		expect(classifyProviderError("context_length_exceeded")).toBe("durable");
		expect(classifyProviderError("stream disconnected before completion")).toBe("transient");
	});
});

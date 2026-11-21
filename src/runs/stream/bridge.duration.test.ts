import { beforeEach, describe, expect, test } from "bun:test";
import { openDatabase, type WarrenDb } from "../../db/client.ts";
import { createRepos, type Repos } from "../../db/repos/index.ts";
import { RunEventBroker } from "../events.ts";
import { bridgeRunStream } from "./bridge.ts";
import { DurationWatch } from "./duration-watch.ts";
import { makeProvider, piAgentEnd, piTurnStart, seedBridgeRun, source } from "./test-helpers.ts";
import type { StreamEventView } from "./types.ts";

/**
 * Per-run wall-clock limit through the real bridge loop
 * (namphuongtran/warren#10). A run that keeps emitting events is invisible to
 * the turn monitor and the watchdog, so the bridge itself enforces
 * `maxDurationMinutes`: past the limit it emits `duration.exceeded`, cancels
 * through the injected seam, and ends `failed` with
 * `failureReason: "duration_exceeded"` for reap to record.
 */

class FakeClock {
	nowMs = 0;
	now(): number {
		return this.nowMs;
	}
}

/** Yields `events`, then parks until the abort signal fires. */
function parkedSource(
	events: StreamEventView[],
): (signal: AbortSignal) => AsyncIterable<StreamEventView> {
	return (signal) =>
		(async function* () {
			for (const event of events) yield event;
			await new Promise<void>((resolve) => {
				if (signal.aborted) resolve();
				else signal.addEventListener("abort", () => resolve(), { once: true });
			});
		})();
}

describe("bridgeRunStream — wall-clock limit (namphuongtran/warren#10)", () => {
	let db: WarrenDb;
	let repos: Repos;
	let broker: RunEventBroker;
	let runId: string;
	let sandboxRunId: string;

	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
		repos = createRepos(db);
		({ runId, sandboxRunId } = await seedBridgeRun(repos));
		broker = new RunEventBroker();
	});

	function bridge(input: {
		readonly watch?: DurationWatch;
		readonly source: (signal: AbortSignal) => AsyncIterable<StreamEventView>;
		readonly cancels: string[];
	}) {
		return bridgeRunStream({
			runId,
			sandboxRunId,
			repos,
			broker,
			sandboxId: "bur_aaaaaaaaaaaa",
			runtimeProvider: makeProvider(),
			cancelBurrowRun: async (reason) => {
				input.cancels.push(reason);
			},
			...(input.watch !== undefined ? { durationWatch: input.watch } : {}),
			source: input.source,
		});
	}

	test("cancels a silent run once the limit elapses and emits duration.exceeded", async () => {
		const clock = new FakeClock();
		const cancels: string[] = [];
		const watch = new DurationWatch({
			limitMs: 1_000,
			startedAtMs: 0,
			clock,
			checkIntervalMs: 5,
		});
		const pending = bridge({
			watch,
			cancels,
			source: parkedSource([piTurnStart(sandboxRunId, 1)]),
		});
		await Bun.sleep(20);
		clock.nowMs = 2_000;
		const result = await pending;

		expect(result.terminalDetected).toEqual({
			outcome: "failed",
			failureReason: "duration_exceeded",
		});
		expect(result.errored).toBe(false);
		expect(cancels).toHaveLength(1);
		expect(cancels[0]).toContain("wall-clock limit exceeded");
		const events = await repos.events.listByRun(runId);
		const exceeded = events.find((e) => e.kind === "duration.exceeded");
		expect(exceeded?.stream).toBe("system");
		expect(exceeded?.payloadJson).toMatchObject({ elapsedMs: 2_000, limitMs: 1_000 });
	});

	test("cancels a busy run on the first event past the limit and persists nothing after it", async () => {
		const clock = new FakeClock();
		const cancels: string[] = [];
		const watch = new DurationWatch({
			limitMs: 1_000,
			startedAtMs: 0,
			clock,
			checkIntervalMs: 60_000,
		});
		async function* busy(): AsyncIterable<StreamEventView> {
			yield piTurnStart(sandboxRunId, 1);
			clock.nowMs = 1_500;
			yield piTurnStart(sandboxRunId, 2);
			yield piAgentEnd(sandboxRunId, 3);
		}
		const result = await bridge({ watch, cancels, source: () => busy() });

		expect(result.terminalDetected).toEqual({
			outcome: "failed",
			failureReason: "duration_exceeded",
		});
		expect(cancels).toHaveLength(1);
		const seqs = (await repos.events.listByRun(runId))
			.filter((e) => e.kind !== "duration.exceeded")
			.map((e) => e.sandboxEventSeq);
		expect(seqs).toEqual([1]);
	});

	test("publishes duration.exceeded to live subscribers before closing the stream", async () => {
		const clock = new FakeClock();
		const watch = new DurationWatch({
			limitMs: 1_000,
			startedAtMs: 0,
			clock,
			checkIntervalMs: 5,
		});
		const seen: string[] = [];
		const tail = (async () => {
			for await (const row of broker.subscribe(runId)) seen.push(row.kind);
		})();
		const pending = bridge({
			watch,
			cancels: [],
			source: parkedSource([piTurnStart(sandboxRunId, 1)]),
		});
		await Bun.sleep(20);
		clock.nowMs = 2_000;
		await pending;
		await tail;
		expect(seen).toContain("duration.exceeded");
	});

	test("trips a resumed run already past its limit before any new event arrives", async () => {
		const clock = new FakeClock();
		clock.nowMs = 5_000;
		const cancels: string[] = [];
		const watch = new DurationWatch({
			limitMs: 1_000,
			startedAtMs: 0,
			clock,
			checkIntervalMs: 60_000,
		});
		const result = await bridge({ watch, cancels, source: parkedSource([]) });
		expect(result.terminalDetected).toEqual({
			outcome: "failed",
			failureReason: "duration_exceeded",
		});
		expect(cancels).toHaveLength(1);
	});

	test("lets a terminal event that lands just past the limit finish the run", async () => {
		const clock = new FakeClock();
		const cancels: string[] = [];
		const watch = new DurationWatch({
			limitMs: 1_000,
			startedAtMs: 0,
			clock,
			checkIntervalMs: 60_000,
		});
		async function* finishing(): AsyncIterable<StreamEventView> {
			yield piTurnStart(sandboxRunId, 1);
			clock.nowMs = 1_500;
			yield piAgentEnd(sandboxRunId, 2);
		}
		const result = await bridge({ watch, cancels, source: () => finishing() });
		expect(result.terminalDetected).toEqual({ outcome: "succeeded" });
		expect(cancels).toHaveLength(0);
	});

	test("never trips a run with no limit, however long it runs", async () => {
		const clock = new FakeClock();
		const cancels: string[] = [];
		const watch = new DurationWatch({
			limitMs: null,
			startedAtMs: 0,
			clock,
			checkIntervalMs: 5,
		});
		async function* longRun(): AsyncIterable<StreamEventView> {
			yield piTurnStart(sandboxRunId, 1);
			clock.nowMs = 10 * 24 * 60 * 60 * 1_000;
			await Bun.sleep(20);
			yield piAgentEnd(sandboxRunId, 2);
		}
		const result = await bridge({ watch, cancels, source: () => longRun() });

		expect(result.terminalDetected).toEqual({ outcome: "succeeded" });
		expect(cancels).toHaveLength(0);
		const events = await repos.events.listByRun(runId);
		expect(events.some((e) => e.kind === "duration.exceeded")).toBe(false);
	});

	test("reads the limit frozen on rendered_agent_json when no watch is injected", async () => {
		const { agentName, projectId } = await repos.runs.require(runId);
		if (projectId === null) throw new Error("seeded run has no project");
		const limited = await repos.runs.create({
			agentName,
			projectId,
			prompt: "p",
			// 0.0005 minutes = 30ms, so a real-clock run crosses it quickly.
			renderedAgentJson: { frontmatter: { maxDurationMinutes: 0.0005 } },
			trigger: "manual",
			sandboxId: "bur_aaaaaaaaaaaa",
			sandboxRunId: "run_yyyyyyyyyyyy",
		});
		runId = limited.id;
		sandboxRunId = "run_yyyyyyyyyyyy";
		const cancels: string[] = [];
		async function* slow(): AsyncIterable<StreamEventView> {
			yield piTurnStart(sandboxRunId, 1);
			await Bun.sleep(60);
			yield piTurnStart(sandboxRunId, 2);
		}
		const result = await bridge({ cancels, source: () => slow() });

		expect(result.terminalDetected).toEqual({
			outcome: "failed",
			failureReason: "duration_exceeded",
		});
		expect(cancels).toHaveLength(1);
	});

	test("leaves a run with no frozen limit unlimited when no watch is injected", async () => {
		const cancels: string[] = [];
		const result = await bridge({
			cancels,
			source: source([piTurnStart(sandboxRunId, 1), piAgentEnd(sandboxRunId, 2)]),
		});
		expect(result.terminalDetected).toEqual({ outcome: "succeeded" });
		expect(cancels).toHaveLength(0);
	});
});

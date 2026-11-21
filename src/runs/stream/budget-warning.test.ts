import { beforeEach, describe, expect, test } from "bun:test";
import { openDatabase } from "../../db/client.ts";
import { createRepos, type Repos } from "../../db/repos/index.ts";
import { RunEventBroker } from "../events.ts";
import { bridgeRunStream } from "./bridge.ts";
import { budgetWarningFractionFromEnv } from "./budget-warning.ts";
import { makeProvider, seedBridgeRun, source } from "./test-helpers.ts";
import type { BridgeRunStreamInput, StreamEventView } from "./types.ts";

/** Pi `turn_end` envelope carrying a per-turn cost total. */
function turnEnd(seq: number, costTotal: number): StreamEventView {
	return {
		seq,
		kind: "state_change",
		stream: "system",
		payload: {
			type: "turn_end",
			message: { usage: { cost: { total: costTotal }, input: 10, output: 5 } },
		},
		ts: new Date(2026, 4, 8, 12, 0, seq),
	};
}

describe("bridgeRunStream — budget warning (namphuongtran/warren#9)", () => {
	let repos: Repos;
	let broker: RunEventBroker;
	let runId: string;
	let sandboxRunId: string;
	let cancels: string[];
	let steers: string[];

	beforeEach(async () => {
		repos = createRepos(await openDatabase({ path: ":memory:" }));
		broker = new RunEventBroker();
		cancels = [];
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
			cancelBurrowRun: async (reason) => {
				cancels.push(reason);
			},
			budgetWarningSteer: async (body) => {
				steers.push(body);
			},
			source: source(events),
			...extra,
		});
	}

	async function kinds(kind: string): Promise<unknown[]> {
		const events = await repos.events.listByRun(runId);
		return events.filter((e) => e.kind === kind).map((e) => e.payloadJson);
	}

	test("emits exactly one budget.warning when cost crosses the warning threshold", async () => {
		await seed();
		// $10 cap, default 80% threshold: $5 → $8.5 crosses, $9 stays past it.
		const result = await bridge([turnEnd(1, 5), turnEnd(2, 3.5), turnEnd(3, 0.5)], {
			costCapUsd: 10,
		});

		expect(result.terminalDetected).toBeUndefined();
		expect(cancels).toHaveLength(0);
		expect(await kinds("budget.warning")).toEqual([
			{ costUsd: 8.5, capUsd: 10, thresholdUsd: 8, fraction: 0.8 },
		]);
	});

	test("still emits budget.exceeded and cancels when cost crosses the cap after the warning", async () => {
		await seed();
		const result = await bridge([turnEnd(1, 8.5), turnEnd(2, 2)], { costCapUsd: 10 });

		expect(result.terminalDetected).toEqual({ outcome: "cancelled" });
		expect(cancels).toHaveLength(1);
		expect(await kinds("budget.warning")).toHaveLength(1);
		expect(await kinds("budget.exceeded")).toEqual([{ costUsd: 10.5, capUsd: 10 }]);
	});

	test("emits no warning when the run has no cap", async () => {
		await seed();
		await bridge([turnEnd(1, 50)]);

		expect(await kinds("budget.warning")).toHaveLength(0);
		expect(steers).toHaveLength(0);
	});

	test("steers a mid-run harness exactly once at the warning", async () => {
		await seed({ frontmatter: { steering: "mid-run", maxCostUsd: 10 } });
		await bridge([turnEnd(1, 8), turnEnd(2, 0.5), turnEnd(3, 0.5)]);

		expect(await kinds("budget.warning")).toHaveLength(1);
		expect(steers).toEqual([
			"You are near the spend cap ($8.00 of $10.00 spent). " +
				"Finish, commit, and write your final message now.",
		]);
	});

	test("does not steer a spawn-only harness such as claude-code", async () => {
		await seed({ frontmatter: { steering: "spawn-only", maxCostUsd: 10 } });
		await bridge([turnEnd(1, 9)]);

		expect(await kinds("budget.warning")).toHaveLength(1);
		expect(steers).toHaveLength(0);
	});

	test("skips a second warning when a resumed bridge is already past the threshold", async () => {
		await seed({ frontmatter: { steering: "mid-run", maxCostUsd: 10 } });
		await bridge([turnEnd(1, 8.5)]);
		// The warning row took seq 2, so the resumed stream continues at seq 3.
		await bridge([turnEnd(1, 8.5), turnEnd(3, 0.5)]);

		expect(await kinds("budget.warning")).toHaveLength(1);
		expect(steers).toHaveLength(1);
	});
});

describe("budgetWarningFractionFromEnv", () => {
	test("defaults to 80% when unset", () => {
		expect(budgetWarningFractionFromEnv({})).toBe(0.8);
	});

	test("reads a fraction between 0 and 1", () => {
		expect(budgetWarningFractionFromEnv({ WARREN_BUDGET_WARNING_FRACTION: "0.9" })).toBe(0.9);
	});

	test("disables the warning at 0", () => {
		expect(budgetWarningFractionFromEnv({ WARREN_BUDGET_WARNING_FRACTION: "0" })).toBeNull();
	});

	test("falls back to 80% on a value outside (0, 1)", () => {
		expect(budgetWarningFractionFromEnv({ WARREN_BUDGET_WARNING_FRACTION: "80" })).toBe(0.8);
		expect(budgetWarningFractionFromEnv({ WARREN_BUDGET_WARNING_FRACTION: "abc" })).toBe(0.8);
	});
});

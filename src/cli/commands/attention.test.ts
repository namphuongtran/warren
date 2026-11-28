import { describe, expect, test } from "bun:test";
import { WarrenClientError } from "../../client/errors.ts";
import type { RunAttentionItem, RunAttentionResponse, WarrenClient } from "../../client/index.ts";
import type { OpsWindow } from "../../core/wire.ts";
import type { CliContext } from "../output.ts";
import { runAttention } from "./attention.ts";

function captureContext(output?: CliContext["output"]) {
	const out: string[] = [];
	const err: string[] = [];
	const context: CliContext = {
		env: {},
		stdio: { stdout: { write: (c) => out.push(c) }, stderr: { write: (c) => err.push(c) } },
		spawn: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
		...(output !== undefined ? { output } : {}),
	};
	return { context, out, err };
}

const BLOCKED: RunAttentionItem = {
	category: "blocked",
	reasons: ["blocked", "gate_failed"],
	run: {
		id: "run_000000000001",
		agentName: "claude-code",
		projectId: "prj_000000000001",
		state: "succeeded",
		failureReason: null,
		trigger: "manual",
		prompt: "Migrate the plan-runs table to the card primitive\nwith every column kept",
		createdAt: 1_000,
		endedAt: "2026-11-28T10:00:00.000Z",
		prUrl: null,
		prState: null,
		prChecks: null,
		qualityGateOutcome: "failed",
		qualityFlags: null,
		handoff: {
			state: "recorded",
			handoff: {
				status: "blocked",
				summary: "The card has no progress slot.",
				verification: [],
				howToTry: [],
				openQuestions: [
					{ question: "Grow a progress slot?", options: [], recommendation: "Yes, a footer." },
				],
			},
		},
	},
};

const FAILED: RunAttentionItem = {
	category: "failed",
	reasons: ["failed"],
	run: { ...BLOCKED.run, id: "run_000000000002", state: "failed", handoff: null },
};

function attentionClient(items: RunAttentionItem[], seen: (OpsWindow | undefined)[] = []) {
	return {
		listAttention: async (window?: OpsWindow): Promise<RunAttentionResponse> => {
			seen.push(window);
			return {
				window: window ?? "7d",
				items,
				generatedAt: "2026-11-28T12:00:00.000Z",
			};
		},
	} as unknown as WarrenClient;
}

describe("runAttention", () => {
	test("emits one ndjson line per item, passing the window through", async () => {
		const { context, out } = captureContext("ndjson");
		const seen: (OpsWindow | undefined)[] = [];
		const res = await runAttention(
			context,
			{ client: attentionClient([BLOCKED, FAILED], seen) },
			{ window: "30d" },
		);
		expect(res).toEqual({ exitCode: 0, count: 2 });
		expect(seen).toEqual(["30d"]);
		const lines = out
			.join("")
			.trimEnd()
			.split("\n")
			.map((l) => JSON.parse(l));
		expect(lines).toEqual([BLOCKED, FAILED]);
	});

	test("renders a table and the blocked run's questions for a human", async () => {
		const { context, out } = captureContext("pretty");
		const res = await runAttention(context, { client: attentionClient([BLOCKED, FAILED]) }, {});
		expect(res.exitCode).toBe(0);
		const text = out.join("");
		expect(text).toMatch(/category\s+run\s+agent\s+reasons\s+task/);
		expect(text).toMatch(
			/blocked\s+run_000000000001\s+claude-code\s+blocked, gate_failed\s+Migrate/,
		);
		expect(text).toMatch(/failed\s+run_000000000002/);
		// Only the task's first line goes in the table.
		expect(text).not.toContain("with every column kept");
		expect(text).toContain("run_000000000001 asks:");
		expect(text).toContain("1. Grow a progress slot?");
		expect(text).toContain("Recommended: Yes, a footer.");
		expect(text).toContain("Needs attention page");
	});

	test("says so when nothing needs attention", async () => {
		const { context, out } = captureContext("pretty");
		const res = await runAttention(context, { client: attentionClient([]) }, {});
		expect(res).toEqual({ exitCode: 0, count: 0 });
		expect(out.join("")).toContain("(nothing needs attention in the last 7d)");
	});

	test("maps a refused credential to the auth exit code", async () => {
		const { context, err } = captureContext("pretty");
		const client = {
			listAttention: async () => {
				throw new WarrenClientError(403, "forbidden", "readOperator required");
			},
		} as unknown as WarrenClient;
		const res = await runAttention(context, { client }, {});
		expect(res.exitCode).toBe(4);
		expect(err.join("")).not.toBe("");
	});
});

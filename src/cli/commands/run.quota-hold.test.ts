/**
 * `warren run --hold-on-quota` (namphuongtran/warren#30): the dispatch asks
 * the server to hold the run on a spent provider quota, and a held run is
 * reported, then tailed like any other until it ends.
 */

import { describe, expect, test } from "bun:test";
import type {
	CreateRunInput,
	RunEvent,
	RunRow,
	SpawnRunResponse,
	WarrenClient,
} from "../../client/index.ts";
import type { CliContext } from "../output.ts";
import { runRun } from "./run.ts";

const HOLD = {
	reason: "provider_quota_exhausted",
	resetsAt: 1795338600,
	releaseAt: "2026-11-22T09:11:30.000Z",
} as const;

function row(state: RunRow["state"]): RunRow {
	return { id: "run-held", agentName: "claude-code", projectId: "prj_1", state } as RunRow;
}

function setup(response: SpawnRunResponse) {
	const out: string[] = [];
	const createCalls: CreateRunInput[] = [];
	const context: CliContext = {
		env: {},
		stdio: { stdout: { write: (c) => out.push(c) }, stderr: { write: () => {} } },
		spawn: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
	};
	const client = {
		probe: async () => {},
		createRun: async (body: CreateRunInput) => {
			createCalls.push(body);
			return response;
		},
		streamRunEvents: () => (async function* (): AsyncGenerator<RunEvent, void, void> {})(),
		getRun: async () => row("succeeded"),
		waitForRun: async () => row("succeeded"),
	} as unknown as WarrenClient;
	return { context, client, out, createCalls };
}

const ARGS = { agent: "claude-code", project: "prj_1", prompt: "do the thing" };

describe("runRun --hold-on-quota", () => {
	test("asks the server to hold the run on a spent quota", async () => {
		const { context, client, createCalls } = setup({
			run: row("queued"),
			sandbox: { id: "bur-1", workspacePath: "" },
		});

		await runRun(context, { client }, { ...ARGS, holdOnQuota: true });

		expect(createCalls[0]?.onQuotaExhausted).toBe("hold");
	});

	test("sends no hold request without the flag", async () => {
		const { context, client, createCalls } = setup({
			run: row("queued"),
			sandbox: { id: "bur-1", workspacePath: "" },
		});

		await runRun(context, { client }, ARGS);

		expect(createCalls[0]?.onQuotaExhausted).toBeUndefined();
	});

	test("reports a held run, then tails it to its end", async () => {
		const { context, client, out } = setup({ run: row("queued"), sandbox: null, quotaHold: HOLD });

		const result = await runRun(context, { client }, { ...ARGS, holdOnQuota: true });

		expect(result.exitCode).toBe(0);
		const lines = out
			.join("")
			.trimEnd()
			.split("\n")
			.map((l) => JSON.parse(l));
		expect(lines[0]).toMatchObject({
			event: "run.held",
			runId: "run-held",
			resetsAt: HOLD.resetsAt,
			releaseAt: HOLD.releaseAt,
		});
		expect(lines.at(-1)).toMatchObject({ event: "run.terminal", state: "succeeded" });
	});
});

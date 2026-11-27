/**
 * The context-window overlay on `GET /runs/:id` (namphuongtran/warren#20):
 * operators see how full the run's context window was at its newest usage
 * reading, beside its cost; spectators never get the fields.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { openDatabase, type WarrenDb } from "../../db/client.ts";
import { createRepos, type Repos } from "../../db/repos/index.ts";
import { FakeProvider } from "../../runtime/fake/fake-provider.ts";
import { bearerAuth, publicReadAuth } from "../auth.ts";
import { startServer } from "../server.ts";
import type { ServeHandle } from "../types.ts";
import { depsFor, silentLogger, tcpUrl } from "./runs.test-helpers.ts";

const TOKEN = "s3cret";

describe("GET /runs/:id context overlay (namphuongtran/warren#20)", () => {
	let db: WarrenDb;
	let repos: Repos;
	let handle: ServeHandle | null = null;
	let base: string;
	let projectId: string;

	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
		repos = createRepos(db);
		const project = await repos.projects.create({
			gitUrl: "https://github.com/os-eco/warren.git",
			localPath: "/data/projects/os-eco/warren",
			defaultBranch: "main",
		});
		projectId = project.id;
		handle = startServer(await depsFor(repos, new FakeProvider()), {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: publicReadAuth(bearerAuth(TOKEN)),
			logger: silentLogger,
		});
		base = tcpUrl(handle);
	});

	afterEach(async () => {
		if (handle) {
			await handle.stop();
			handle = null;
		}
		await db.close();
	});

	async function createRun(): Promise<string> {
		const row = await repos.runs.create({
			agentName: "pi",
			projectId,
			prompt: "fix the bug",
			renderedAgentJson: { name: "pi", frontmatter: {} },
			trigger: "manual",
		});
		await repos.runs.markRunning(row.id, new Date("2026-11-27T10:00:00.000Z"));
		return row.id;
	}

	async function append(runId: string, seq: number, kind: string, payload: unknown) {
		await repos.events.append({
			runId,
			sandboxEventSeq: seq,
			ts: new Date(Date.UTC(2026, 10, 27, 10, 0, seq)).toISOString(),
			kind,
			stream: "system",
			payload,
		});
	}

	function turnEnd(totalTokens: number) {
		return { type: "turn_end", message: { model: "claude-sonnet-5-5", usage: { totalTokens } } };
	}

	async function detail(runId: string, token?: string): Promise<Record<string, unknown>> {
		const res = await fetch(
			`${base}/runs/${runId}`,
			token === undefined ? {} : { headers: { authorization: `Bearer ${token}` } },
		);
		expect(res.status).toBe(200);
		return ((await res.json()) as { run: Record<string, unknown> }).run;
	}

	test("serves the newest context reading to an operator", async () => {
		const runId = await createRun();
		await append(runId, 1, "state_change", turnEnd(50_000));
		await append(runId, 2, "state_change", { type: "turn_start" });
		await append(runId, 3, "state_change", turnEnd(120_000));
		await append(runId, 4, "state_change", { type: "turn_start" });

		const run = await detail(runId, TOKEN);
		expect(run.contextTokens).toBe(120_000);
		expect(run.contextWindowTokens).toBe(200_000);
	});

	test("reads the window off the run's model when the usage names the bare id", async () => {
		const runId = await createRun();
		await repos.runs.setModel(runId, "claude-sonnet-5-5[1m]");
		await append(runId, 1, "telemetry", {
			type: "assistant_usage",
			message: { id: "msg_1", model: "claude-sonnet-5-5", usage: { input_tokens: 400_000 } },
		});

		const run = await detail(runId, TOKEN);
		expect(run.contextTokens).toBe(400_000);
		expect(run.contextWindowTokens).toBe(1_000_000);
	});

	test("serves nulls for a run with no reading yet", async () => {
		const runId = await createRun();

		const run = await detail(runId, TOKEN);
		expect(run.contextTokens).toBeNull();
		expect(run.contextWindowTokens).toBeNull();
	});

	test("omits the fields for a spectator", async () => {
		const runId = await createRun();
		await append(runId, 1, "state_change", turnEnd(50_000));

		const run = await detail(runId);
		expect(run).not.toHaveProperty("contextTokens");
		expect(run).not.toHaveProperty("contextWindowTokens");
	});
});

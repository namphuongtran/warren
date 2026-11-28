/**
 * The needs-input overlay on `GET /runs` and `GET /runs/:id`
 * (namphuongtran/warren#25). A run whose handoff is blocked needs operator
 * input until a continuation answers it. The flag is derived from the stored
 * handoff and the run links, never stored, and spectators never get it.
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

describe("GET /runs needs-input overlay (namphuongtran/warren#25)", () => {
	let db: WarrenDb;
	let repos: Repos;
	let handle: ServeHandle | null = null;
	let base: string;
	let projectId: string;
	let blockedId: string;
	let doneId: string;

	async function finishedRun(prompt: string, status: "blocked" | "done"): Promise<string> {
		const row = await repos.runs.create({
			agentName: "claude-code",
			projectId,
			prompt,
			renderedAgentJson: { name: "claude-code", frontmatter: {} },
			trigger: "manual",
		});
		await repos.runs.markRunning(row.id, new Date("2026-11-27T10:00:00.000Z"));
		await repos.runs.finalize(row.id, "succeeded", new Date("2026-11-27T10:05:00.000Z"), null);
		await repos.runs.setHandoff(row.id, {
			state: "recorded",
			handoff: {
				status,
				summary: "The card has no progress slot.",
				verification: [],
				howToTry: [],
				openQuestions:
					status === "blocked"
						? [{ question: "Grow a progress slot?", options: [], recommendation: "Yes." }]
						: [],
			},
		});
		return row.id;
	}

	async function childOf(
		parentRunId: string,
		cloneKind: "continue" | "replicate",
		trigger = "manual",
	) {
		return repos.runs.create({
			agentName: "claude-code",
			projectId,
			prompt: "Grow a footer slot.",
			renderedAgentJson: { name: "claude-code", frontmatter: {} },
			trigger,
			parentRunId,
			cloneKind,
		});
	}

	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
		repos = createRepos(db);
		const project = await repos.projects.create({
			gitUrl: "https://github.com/os-eco/warren.git",
			localPath: "/data/projects/os-eco/warren",
			defaultBranch: "main",
		});
		projectId = project.id;
		blockedId = await finishedRun("move the table onto cards", "blocked");
		doneId = await finishedRun("fix the typo", "done");
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

	async function get(path: string, token?: string): Promise<Record<string, unknown>> {
		const res = await fetch(
			`${base}${path}`,
			token === undefined ? {} : { headers: { authorization: `Bearer ${token}` } },
		);
		expect(res.status).toBe(200);
		return (await res.json()) as Record<string, unknown>;
	}

	async function listRow(id: string, token?: string): Promise<Record<string, unknown>> {
		const runs = (await get("/runs", token)).runs as Record<string, unknown>[];
		const row = runs.find((r) => r.id === id);
		if (row === undefined) throw new Error(`run ${id} missing from GET /runs`);
		return row;
	}

	async function detail(id: string, token?: string): Promise<Record<string, unknown>> {
		return (await get(`/runs/${id}`, token)).run as Record<string, unknown>;
	}

	test("flags a blocked run as needing input on the operator list and detail", async () => {
		for (const run of [await listRow(blockedId, TOKEN), await detail(blockedId, TOKEN)]) {
			expect(run.needsInput).toBe(true);
			expect(run.answeredByRunId).toBeNull();
		}
	});

	test("leaves a run that is not blocked unflagged", async () => {
		for (const run of [await listRow(doneId, TOKEN), await detail(doneId, TOKEN)]) {
			expect(run.needsInput).toBe(false);
			expect(run.answeredByRunId).toBeNull();
		}
	});

	test("clears the flag once a continuation answers the blocked run", async () => {
		const continuation = await childOf(blockedId, "continue");
		for (const run of [await listRow(blockedId, TOKEN), await detail(blockedId, TOKEN)]) {
			expect(run.needsInput).toBe(false);
			expect(run.answeredByRunId).toBe(continuation.id);
		}
	});

	test("counts a continuation dispatched from the CLI as an answer", async () => {
		const continuation = await childOf(blockedId, "continue", "cli");
		expect((await detail(blockedId, TOKEN)).answeredByRunId).toBe(continuation.id);
	});

	// An automatic continuation, such as a CI fix on the blocked run's PR, is
	// not the operator answering its questions.
	test("does not count an automatic continuation as an answer", async () => {
		await childOf(blockedId, "continue", "ci-fixer");
		const run = await detail(blockedId, TOKEN);
		expect(run.needsInput).toBe(true);
		expect(run.answeredByRunId).toBeNull();
	});

	test("does not count a from-scratch re-run as an answer", async () => {
		await childOf(blockedId, "replicate");
		const run = await detail(blockedId, TOKEN);
		expect(run.needsInput).toBe(true);
		expect(run.answeredByRunId).toBeNull();
	});

	test("omits the fields for a spectator", async () => {
		for (const run of [await listRow(blockedId), await detail(blockedId)]) {
			expect(run).not.toHaveProperty("needsInput");
			expect(run).not.toHaveProperty("answeredByRunId");
		}
	});
});

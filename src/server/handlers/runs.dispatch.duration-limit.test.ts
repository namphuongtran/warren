import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type WarrenDb } from "../../db/client.ts";
import { createRepos, type Repos } from "../../db/repos/index.ts";
import { NO_AUTH } from "../auth.ts";
import { startServer } from "../server.ts";
import type { BridgeRegistry, ServeHandle } from "../types.ts";
import { depsFor, makeSandboxClient, silentLogger, tcpUrl } from "./runs.test-helpers.ts";

/**
 * The per-run wall-clock limit at the HTTP boundary: `maxDurationMinutes` is
 * an optional positive number folded onto the frozen frontmatter, where the
 * event bridge reads it; omitted leaves the run unlimited; anything else is
 * a 400.
 */
describe("POST /runs — maxDurationMinutes (namphuongtran/warren#10)", () => {
	let db: WarrenDb;
	let repos: Repos;
	let handle: ServeHandle | null = null;
	let projectId = "";

	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
		repos = createRepos(db);
		await repos.agents.upsert({
			name: "refactor-bot",
			renderedJson: {
				name: "refactor-bot",
				version: 1,
				sections: { system: "you are refactor-bot" },
				resolvedFrom: [],
				frontmatter: {},
			},
		});
		const project = await repos.projects.create({
			gitUrl: "https://github.com/x/y.git",
			localPath: await mkdtemp(join(tmpdir(), "warren-handlers-duration-proj-")),
			defaultBranch: "main",
		});
		projectId = project.id;
		const bridges: BridgeRegistry = { start: () => {}, stopAll: async () => {}, size: () => 0 };
		const sandboxClient = makeSandboxClient(
			{
				sandboxId: "bur_durat0000000",
				sandboxRunId: "run_duratrun00000",
				workspacePath: await mkdtemp(join(tmpdir(), "warren-handlers-duration-ws-")),
			},
			[],
		);
		handle = startServer(await depsFor(repos, sandboxClient, bridges), {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});
	});

	afterEach(async () => {
		if (handle) {
			await handle.stop();
			handle = null;
		}
		await db.close();
	});

	async function post(extra: Record<string, unknown>): Promise<Response> {
		if (!handle) throw new Error("server not started");
		return fetch(`${tcpUrl(handle)}/runs`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ agent: "refactor-bot", project: projectId, prompt: "go", ...extra }),
		});
	}

	async function frozenFrontmatter(res: Response): Promise<Record<string, unknown>> {
		const body = (await res.json()) as { run: { id: string } };
		const row = await repos.runs.require(body.run.id);
		return (row.renderedAgentJson as { frontmatter: Record<string, unknown> }).frontmatter;
	}

	test("freezes an explicit limit onto the run's frontmatter", async () => {
		const res = await post({ maxDurationMinutes: 45 });
		expect(res.status).toBe(201);
		expect((await frozenFrontmatter(res)).maxDurationMinutes).toBe(45);
	});

	test("leaves the run unlimited when the limit is omitted", async () => {
		const res = await post({});
		expect(res.status).toBe(201);
		expect(await frozenFrontmatter(res)).not.toHaveProperty("maxDurationMinutes");
	});

	test("rejects a non-positive or non-numeric limit with 400", async () => {
		expect((await post({ maxDurationMinutes: 0 })).status).toBe(400);
		expect((await post({ maxDurationMinutes: -5 })).status).toBe(400);
		expect((await post({ maxDurationMinutes: "45" })).status).toBe(400);
	});
});

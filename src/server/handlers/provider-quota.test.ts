import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type WarrenDb } from "../../db/client.ts";
import { createRepos, type Repos } from "../../db/repos/index.ts";
import { recordQuotaObservation } from "../../runs/quota/state.ts";
import { NO_AUTH } from "../auth.ts";
import { startServer } from "../server.ts";
import type { BridgeRegistry, ServeHandle } from "../types.ts";
import { depsFor, makeSandboxClient, silentLogger, tcpUrl } from "./runs.test-helpers.ts";

/**
 * The provider-quota dispatch guard at the HTTP boundary
 * (namphuongtran/warren#30): `POST /runs` into a spent usage window answers
 * 429 `provider_quota_exhausted` with a `Retry-After` that ends at the reset,
 * `force: true` dispatches anyway, and `GET /provider-quota` shows the state.
 */
describe("provider quota over HTTP (namphuongtran/warren#30)", () => {
	const WINDOW_SECONDS = 3600;
	let db: WarrenDb;
	let repos: Repos;
	let handle: ServeHandle | null = null;
	let projectId = "";
	let resetsAt = 0;

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
			localPath: await mkdtemp(join(tmpdir(), "warren-handlers-quota-proj-")),
			defaultBranch: "main",
		});
		projectId = project.id;
		// The server dispatches with its own process env, so close the window
		// for whatever anthropic credential that env holds.
		resetsAt = Math.floor(Date.now() / 1000) + WINDOW_SECONDS;
		await recordQuotaObservation(repos, {
			credential: { provider: "anthropic", env: process.env },
			observation: { status: "rejected", utilization: 1, rateLimitType: "five_hour", resetsAt },
			source: "rate_limit_event",
			sourceRunId: "run_jy2cxd7cmg9f",
			observedAt: new Date().toISOString(),
		});
		const bridges: BridgeRegistry = { start: () => {}, stopAll: async () => {}, size: () => 0 };
		const sandboxClient = makeSandboxClient(
			{
				sandboxId: "bur_quota0000000",
				sandboxRunId: "run_quotarun00000",
				workspacePath: await mkdtemp(join(tmpdir(), "warren-handlers-quota-ws-")),
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

	function url(path: string): string {
		if (!handle) throw new Error("server not started");
		return `${tcpUrl(handle)}${path}`;
	}

	async function post(extra: Record<string, unknown>): Promise<Response> {
		return fetch(url("/runs"), {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ agent: "refactor-bot", project: projectId, prompt: "go", ...extra }),
		});
	}

	test("POST /runs answers 429 provider_quota_exhausted with Retry-After", async () => {
		const res = await post({});

		expect(res.status).toBe(429);
		const retryAfter = Number(res.headers.get("Retry-After"));
		expect(retryAfter).toBeGreaterThan(WINDOW_SECONDS - 60);
		expect(retryAfter).toBeLessThanOrEqual(WINDOW_SECONDS);
		const body = (await res.json()) as { error: { code: string; hint?: string } };
		expect(body.error.code).toBe("provider_quota_exhausted");
		expect(body.error.hint).toContain("force");
		expect(await repos.runs.listAll()).toEqual([]);
	});

	test("POST /runs with force: true dispatches into the spent window", async () => {
		const res = await post({ force: true });

		expect(res.status).toBe(201);
	});

	test("POST /runs refuses a force that is not a boolean", async () => {
		const res = await post({ force: "yes" });

		expect(res.status).toBe(400);
	});

	test("GET /provider-quota lists the window by fingerprint", async () => {
		const res = await fetch(url("/provider-quota"));

		expect(res.status).toBe(200);
		const body = (await res.json()) as { quotas: Record<string, unknown>[] };
		expect(body.quotas).toEqual([
			expect.objectContaining({
				provider: "anthropic",
				status: "rejected",
				resetsAt,
				exhausted: true,
				sourceRunId: "run_jy2cxd7cmg9f",
			}),
		]);
		for (const secret of [process.env.ANTHROPIC_API_KEY, process.env.CLAUDE_CODE_OAUTH_TOKEN]) {
			if (secret !== undefined && secret !== "") {
				expect(JSON.stringify(body)).not.toContain(secret);
			}
		}
	});
});

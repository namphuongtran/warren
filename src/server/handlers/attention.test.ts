/**
 * `GET /attention` (namphuongtran/warren#26): the finished runs that wait on
 * the operator, derived on read from what the run rows already store.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunAttentionResponse, RunHandoffRecord } from "../../core/wire.ts";
import { openDatabase, type WarrenDb } from "../../db/client.ts";
import { createRepos, type Repos } from "../../db/repos/index.ts";
import { bearerAuth, publicReadAuth } from "../auth.ts";
import { startServer } from "../server.ts";
import type { ServeHandle } from "../types.ts";
import { depsFor, makeSandboxClient, silentLogger, tcpUrl } from "./runs.test-helpers.ts";

const TOKEN = "s3cret";
const NOW = new Date("2026-11-28T12:00:00.000Z");
const HOUR_MS = 60 * 60 * 1000;
const AGENT = { name: "claude-code", version: 1, sections: { system: "x" }, frontmatter: {} };

const BLOCKED: RunHandoffRecord = {
	state: "recorded",
	handoff: {
		status: "blocked",
		summary: "The card has no progress slot.",
		verification: [],
		howToTry: [],
		openQuestions: [{ question: "Grow a progress slot?", options: [], recommendation: "Yes." }],
	},
};

type RunKey = "blocked" | "review" | "failed" | "quality" | "quiet" | "oldFailed";

describe("GET /attention (namphuongtran/warren#26)", () => {
	let db: WarrenDb;
	let repos: Repos;
	let handle: ServeHandle | null = null;
	let base: string;
	let projectId: string;
	let projectDir: string;
	const ids = {} as Record<RunKey, string>;

	async function finished(
		key: RunKey,
		hoursAgo: number,
		state: "succeeded" | "failed",
	): Promise<string> {
		const queued = new Date(NOW.getTime() - hoursAgo * HOUR_MS);
		const row = await repos.runs.create({
			agentName: "claude-code",
			projectId,
			prompt: `task ${key}`,
			renderedAgentJson: AGENT,
			trigger: "manual",
			now: queued,
		});
		await repos.runs.markRunning(row.id, queued);
		await repos.runs.finalize(row.id, state, queued, state === "failed" ? "timed_out" : null);
		ids[key] = row.id;
		return row.id;
	}

	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
		repos = createRepos(db);
		projectDir = await mkdtemp(join(tmpdir(), "warren-attention-"));
		await repos.agents.upsert({ name: "claude-code", renderedJson: AGENT });
		const project = await repos.projects.create({
			gitUrl: "https://github.com/os-eco/warren.git",
			localPath: projectDir,
			defaultBranch: "main",
		});
		projectId = project.id;

		await repos.runs.setHandoff(await finished("blocked", 1, "succeeded"), BLOCKED);
		const review = await finished("review", 2, "succeeded");
		await repos.runs.setPrUrl(review, "https://github.com/os-eco/warren/pull/7");
		await repos.runs.setPrState(review, "open", null);
		await repos.runs.setPrChecks(review, {
			state: "passing",
			failing: [],
			commit: "4f1c2a9e",
			checkedAt: NOW.toISOString(),
			review: { state: "changes_requested", description: "Changes requested (fix round 1 of 2)" },
		});
		await finished("failed", 3, "failed");
		await repos.runs.setQualityGateOutcome(await finished("quality", 4, "succeeded"), "not_run");
		await finished("quiet", 5, "succeeded");
		await finished("oldFailed", 10 * 24, "failed");

		const sandbox = makeSandboxClient(
			{ sandboxId: "bur_att000000000", sandboxRunId: "run_attrun000000", workspacePath: "/tmp/ws" },
			[],
		);
		handle = startServer(
			{ ...(await depsFor(repos, sandbox)), now: () => NOW },
			{
				transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
				auth: publicReadAuth(bearerAuth(TOKEN)),
				logger: silentLogger,
			},
		);
		base = tcpUrl(handle);
	});

	afterEach(async () => {
		if (handle) {
			await handle.stop();
			handle = null;
		}
		await db.close();
		await rm(projectDir, { recursive: true, force: true });
	});

	async function attention(query = ""): Promise<RunAttentionResponse> {
		const res = await fetch(`${base}/attention${query}`, {
			headers: { authorization: `Bearer ${TOKEN}` },
		});
		expect(res.status).toBe(200);
		return (await res.json()) as RunAttentionResponse;
	}

	const listed = (body: RunAttentionResponse) =>
		body.items.map((item) => [item.run.id, item.category, item.reasons]);
	const failedIds = (body: RunAttentionResponse) =>
		body.items.filter((item) => item.category === "failed").map((item) => item.run.id);

	test("lists the runs that wait on the operator, grouped by category, over 7 days", async () => {
		const body = await attention();
		expect(body.window).toBe("7d");
		expect(body.generatedAt).toBe(NOW.toISOString());
		expect(listed(body)).toEqual([
			[ids.blocked, "blocked", ["blocked"]],
			[ids.review, "review", ["changes_requested"]],
			[ids.failed, "failed", ["failed"]],
			[ids.quality, "quality", ["gate_not_run"]],
		]);
		const blocked = body.items[0]?.run;
		expect(blocked?.prompt).toBe("task blocked");
		expect(blocked?.handoff).toEqual(BLOCKED);
		expect(body.items[1]?.run.prChecks?.review?.description).toContain("fix round 1 of 2");
	});

	test("covers older runs when the window widens", async () => {
		const body = await attention("?window=30d");
		expect(body.window).toBe("30d");
		expect(body.items.map((item) => item.run.id)).toContain(ids.oldFailed);
		expect(failedIds(body)).toEqual([ids.failed, ids.oldFailed]);
	});

	test("rejects an unknown window", async () => {
		const res = await fetch(`${base}/attention?window=1y`, {
			headers: { authorization: `Bearer ${TOKEN}` },
		});
		expect(res.status).toBe(400);
	});

	test("refuses a spectator on a public instance", async () => {
		const res = await fetch(`${base}/attention`);
		expect(res.status).toBe(403);
	});

	test("drops a blocked run once the operator dispatches its continuation", async () => {
		const res = await fetch(`${base}/runs`, {
			method: "POST",
			headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
			body: JSON.stringify({
				agent: "claude-code",
				project: projectId,
				prompt: "task blocked\n\n## The operator's answers\n\n1. Yes.",
				continueFromRunId: ids.blocked,
			}),
		});
		expect(res.status).toBe(201);
		const continuation = ((await res.json()) as { run: { parentRunId: string } }).run;
		expect(continuation.parentRunId).toBe(ids.blocked);

		const body = await attention();
		expect(body.items.map((item) => item.run.id)).not.toContain(ids.blocked);
	});

	test("drops a failed run once it is re-run, but not for a CI fix", async () => {
		const child = (trigger: string) =>
			repos.runs.create({
				agentName: "claude-code",
				projectId,
				prompt: "again",
				renderedAgentJson: AGENT,
				trigger,
				parentRunId: ids.failed,
				cloneKind: "continue",
				now: NOW,
			});
		await child("ci-fixer");
		expect(failedIds(await attention())).toEqual([ids.failed]);
		await child("cron");
		expect(failedIds(await attention())).toEqual([]);
	});
});

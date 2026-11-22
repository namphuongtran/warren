/**
 * The stalled tool call overlay on `GET /runs` and `GET /runs/:id`
 * (namphuongtran/warren#83): operators see which call a running run is stuck
 * on; spectators never get the field.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { openDatabase, type WarrenDb } from "../../db/client.ts";
import { createRepos, type Repos } from "../../db/repos/index.ts";
import { WATCHDOG_TOOL_STALLED_KIND } from "../../runs/watchdog-tool-stall.ts";
import { FakeProvider } from "../../runtime/fake/fake-provider.ts";
import { bearerAuth, publicReadAuth } from "../auth.ts";
import { startServer } from "../server.ts";
import type { ServeHandle } from "../types.ts";
import { depsFor, silentLogger, tcpUrl } from "./runs.test-helpers.ts";

const TOKEN = "s3cret";
const TOOL_USE_AT = "2026-11-22T10:05:00.000Z";
const WARNED_AT = "2026-11-22T10:25:00.000Z";
const TOOL_USE_ID = "toolu_016v62cYWga7ttHSxU7F6Qkt";

describe("GET /runs tool-stall overlay (namphuongtran/warren#83)", () => {
	let db: WarrenDb;
	let repos: Repos;
	let handle: ServeHandle | null = null;
	let base: string;
	let runId: string;

	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
		repos = createRepos(db);
		const project = await repos.projects.create({
			gitUrl: "https://github.com/os-eco/warren.git",
			localPath: "/data/projects/os-eco/warren",
			defaultBranch: "main",
		});
		const row = await repos.runs.create({
			agentName: "claude-code",
			projectId: project.id,
			prompt: "run the gate",
			renderedAgentJson: { name: "claude-code", frontmatter: {} },
			trigger: "manual",
		});
		runId = row.id;
		await repos.runs.markRunning(runId, new Date("2026-11-22T10:00:00.000Z"));
		await repos.events.append({
			runId,
			sandboxEventSeq: 1,
			ts: TOOL_USE_AT,
			kind: "tool_use",
			stream: "stdout",
			payload: {
				type: "tool_use",
				id: TOOL_USE_ID,
				name: "Bash",
				input: { command: "uv run pytest -q" },
			},
		});
		await repos.events.append({
			runId,
			sandboxEventSeq: 2,
			ts: WARNED_AT,
			kind: WATCHDOG_TOOL_STALLED_KIND,
			stream: "system",
			payload: {
				toolUseId: TOOL_USE_ID,
				toolName: "Bash",
				command: "uv run pytest -q",
				elapsedMs: 20 * 60_000,
				toolStallWarnMs: 15 * 60_000,
			},
		});
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

	const expected = {
		toolUseId: TOOL_USE_ID,
		toolName: "Bash",
		command: "uv run pytest -q",
		openedAt: TOOL_USE_AT,
		warnedAt: WARNED_AT,
	};

	test("serves the stalled call on the operator list and detail", async () => {
		const list = (await get("/runs", TOKEN)).runs as Record<string, unknown>[];
		expect(list[0]?.toolStall).toEqual(expected);
		const detail = (await get(`/runs/${runId}`, TOKEN)).run as Record<string, unknown>;
		expect(detail.toolStall).toEqual(expected);
	});

	test("omits the field for a spectator", async () => {
		const list = (await get("/runs")).runs as Record<string, unknown>[];
		expect(list[0]).not.toHaveProperty("toolStall");
		const detail = (await get(`/runs/${runId}`)).run as Record<string, unknown>;
		expect(detail).not.toHaveProperty("toolStall");
	});
});

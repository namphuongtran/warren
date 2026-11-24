/**
 * The held-run overlay on `GET /runs` (namphuongtran/warren#30): operators see
 * which runs wait for a provider quota window and when each starts;
 * spectators never get the field.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { QUOTA_HOLD_EVENTS } from "../../core/wire.ts";
import { openDatabase, type WarrenDb } from "../../db/client.ts";
import { createRepos, type Repos } from "../../db/repos/index.ts";
import { FakeProvider } from "../../runtime/fake/fake-provider.ts";
import { bearerAuth, publicReadAuth } from "../auth.ts";
import { startServer } from "../server.ts";
import type { ServeHandle } from "../types.ts";
import { depsFor, silentLogger, tcpUrl } from "./runs.test-helpers.ts";

const TOKEN = "s3cret";
const RESETS_AT = 1795338600;
const RELEASE_AT = "2026-11-22T09:11:30.000Z";

describe("GET /runs quota-hold overlay (namphuongtran/warren#30)", () => {
	let db: WarrenDb;
	let repos: Repos;
	let handle: ServeHandle | null = null;
	let base: string;
	let heldId: string;

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
			prompt: "nightly sweep",
			renderedAgentJson: { name: "claude-code", frontmatter: {} },
			trigger: "cron",
		});
		heldId = row.id;
		await repos.events.append({
			runId: heldId,
			sandboxEventSeq: 1,
			ts: "2026-11-22T08:50:43.000Z",
			kind: QUOTA_HOLD_EVENTS.held,
			stream: "system",
			payload: {
				reason: "provider_quota_exhausted",
				resetsAt: RESETS_AT,
				releaseAt: RELEASE_AT,
				request: { agentName: "claude-code", projectId: project.id, prompt: "nightly sweep" },
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

	async function listRuns(token?: string): Promise<Record<string, unknown>[]> {
		const res = await fetch(
			`${base}/runs`,
			token === undefined ? {} : { headers: { authorization: `Bearer ${token}` } },
		);
		expect(res.status).toBe(200);
		return ((await res.json()) as { runs: Record<string, unknown>[] }).runs;
	}

	test("serves the hold on the operator list", async () => {
		const [run] = await listRuns(TOKEN);

		expect(run?.id).toBe(heldId);
		expect(run?.quotaHold).toEqual({
			reason: "provider_quota_exhausted",
			resetsAt: RESETS_AT,
			releaseAt: RELEASE_AT,
		});
	});

	test("omits the field for a spectator", async () => {
		const [run] = await listRuns();

		expect(run).not.toHaveProperty("quotaHold");
	});
});

/**
 * `GET /runs` filters and the attention overlay (namphuongtran/warren#39):
 * `?attention=1`, `?gate=` and `?pr=` filter in the query, so the page, the
 * total, and the cost rollup all cover the filtered set; each operator row
 * carries the reasons it needs the operator.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunQualityGateOutcome } from "../../core/wire.ts";
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

interface ListBody {
	readonly runs: readonly { readonly id: string; readonly attentionReasons?: unknown }[];
	readonly total: number;
	readonly costTotalUsd?: number;
}

describe("GET /runs filters (namphuongtran/warren#39)", () => {
	let db: WarrenDb;
	let repos: Repos;
	let handle: ServeHandle | null = null;
	let base: string;
	let projectId: string;
	let otherProjectId: string;
	let projectDir: string;

	/** A finished run queued `hoursAgo`, newest-first by that age in the list. */
	async function finished(
		hoursAgo: number,
		opts: {
			state?: "succeeded" | "failed";
			gate?: RunQualityGateOutcome;
			pr?: { n: number; state: "open" | "merged" | "closed_unmerged" | null };
			project?: string;
			costUsd?: number;
		} = {},
	): Promise<string> {
		const at = new Date(NOW.getTime() - hoursAgo * HOUR_MS);
		const state = opts.state ?? "succeeded";
		const row = await repos.runs.create({
			agentName: "claude-code",
			projectId: opts.project ?? projectId,
			prompt: "task",
			renderedAgentJson: AGENT,
			trigger: "manual",
			now: at,
		});
		await repos.runs.markRunning(row.id, at);
		await repos.runs.finalize(row.id, state, at, state === "failed" ? "timed_out" : null);
		if (opts.gate !== undefined) await repos.runs.setQualityGateOutcome(row.id, opts.gate);
		if (opts.costUsd !== undefined) await repos.runs.attachStats(row.id, { costUsd: opts.costUsd });
		if (opts.pr !== undefined) {
			await repos.runs.setPrUrl(row.id, `https://github.com/os-eco/warren/pull/${opts.pr.n}`);
			if (opts.pr.state !== null) await repos.runs.setPrState(row.id, opts.pr.state, null);
		}
		return row.id;
	}

	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
		repos = createRepos(db);
		projectDir = await mkdtemp(join(tmpdir(), "warren-runs-filters-"));
		await repos.agents.upsert({ name: "claude-code", renderedJson: AGENT });
		const project = await repos.projects.create({
			gitUrl: "https://github.com/os-eco/warren.git",
			localPath: projectDir,
			defaultBranch: "main",
		});
		projectId = project.id;
		const other = await repos.projects.create({
			gitUrl: "https://github.com/os-eco/docs-site.git",
			localPath: join(projectDir, "other"),
			defaultBranch: "main",
		});
		otherProjectId = other.id;
		const sandbox = makeSandboxClient(
			{ sandboxId: "bur_flt000000000", sandboxRunId: "run_fltrun000000", workspacePath: "/tmp/ws" },
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

	async function list(query: string, token: string | null = TOKEN): Promise<Response> {
		return fetch(`${base}/runs${query}`, {
			headers: token === null ? {} : { authorization: `Bearer ${token}` },
		});
	}

	async function listOk(query: string, token: string | null = TOKEN): Promise<ListBody> {
		const res = await list(query, token);
		expect(res.status).toBe(200);
		return (await res.json()) as ListBody;
	}

	const ids = (body: ListBody) => body.runs.map((run) => run.id);

	test("keeps the runs whose gate outcome matches ?gate, paging over the filtered set", async () => {
		const f1 = await finished(1, { gate: "failed", costUsd: 1 });
		await finished(2, { gate: "passed", costUsd: 4 });
		const f2 = await finished(3, { gate: "failed", costUsd: 2 });
		await finished(4);
		const f3 = await finished(5, { gate: "failed" });

		const first = await listOk("?gate=failed&limit=2");
		expect(ids(first)).toEqual([f1, f2]);
		expect(first.total).toBe(3);
		expect(first.costTotalUsd).toBe(3);
		const second = await listOk("?gate=failed&limit=2&offset=2");
		expect(ids(second)).toEqual([f3]);
		expect(second.total).toBe(3);
	});

	test("keeps the runs by their pull request with ?pr=any, open, or merged", async () => {
		const open = await finished(1, { pr: { n: 1, state: "open" } });
		const unpolled = await finished(2, { pr: { n: 2, state: null } });
		const merged = await finished(3, { pr: { n: 3, state: "merged" } });
		const closed = await finished(4, { pr: { n: 4, state: "closed_unmerged" } });
		await finished(5);

		expect(ids(await listOk("?pr=any"))).toEqual([open, unpolled, merged, closed]);
		const secondPage = await listOk("?pr=any&limit=2&offset=2");
		expect(ids(secondPage)).toEqual([merged, closed]);
		expect(secondPage.total).toBe(4);
		expect(ids(await listOk("?pr=open"))).toEqual([open, unpolled]);
		const mergedOnly = await listOk("?pr=merged");
		expect(ids(mergedOnly)).toEqual([merged]);
		expect(mergedOnly.total).toBe(1);
	});

	test("keeps the runs the Needs attention page lists over 30 days with ?attention=1", async () => {
		const failed = await finished(1, { state: "failed" });
		await finished(2, { gate: "passed" });
		const notRun = await finished(3, { gate: "not_run" });
		await finished(4, { gate: "not_run", pr: { n: 9, state: "merged" } });
		const oldFailed = await finished(20 * 24, { state: "failed" });
		await finished(40 * 24, { state: "failed" });

		const first = await listOk("?attention=1&limit=2");
		expect(ids(first)).toEqual([failed, notRun]);
		expect(first.total).toBe(3);
		expect(ids(await listOk("?attention=1&limit=2&offset=2"))).toEqual([oldFailed]);
	});

	test("combines the filters with each other and with ?project", async () => {
		const here = await finished(1, { state: "failed", gate: "failed" });
		await finished(2, { state: "failed", gate: "failed", project: otherProjectId });
		await finished(3, { gate: "failed", pr: { n: 5, state: "merged" } });

		const body = await listOk(`?project=${projectId}&attention=1&gate=failed`);
		expect(ids(body)).toEqual([here]);
		expect(body.total).toBe(1);
	});

	test("matches nothing, not everything, when no run needs the operator", async () => {
		await finished(1, { gate: "passed" });
		const body = await listOk("?attention=1");
		expect(body.runs).toEqual([]);
		expect(body.total).toBe(0);
	});

	test("rejects a filter value it does not know", async () => {
		for (const query of ["?gate=green", "?pr=closed", "?attention=yes", "?attention=0"]) {
			expect((await list(query)).status).toBe(400);
		}
	});

	test("refuses ?attention to a spectator, who may still filter on the gate and the PR", async () => {
		const failed = await finished(1, { state: "failed", gate: "failed" });
		const res = await list("?attention=1", null);
		expect(res.status).toBe(403);
		expect(((await res.json()) as { error: { code: string } }).error.code).toBe("forbidden");
		expect(ids(await listOk("?gate=failed", null))).toEqual([failed]);
		expect(ids(await listOk("?pr=any", null))).toEqual([]);
	});

	test("gives each operator row the reasons it needs the operator, and a spectator none", async () => {
		const failed = await finished(1, { state: "failed", gate: "not_run" });
		const quiet = await finished(2, { gate: "passed" });

		const operator = await listOk("");
		const reasons = new Map(operator.runs.map((run) => [run.id, run.attentionReasons]));
		expect(reasons.get(failed)).toEqual(["failed", "gate_not_run"]);
		expect(reasons.get(quiet)).toEqual([]);

		const spectator = await listOk("", null);
		for (const run of spectator.runs) expect(run).not.toHaveProperty("attentionReasons");
	});
});

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { openDatabase, type WarrenDb } from "../../db/client.ts";
import { createRepos, type Repos } from "../../db/repos/index.ts";
import type { CheckRun, PullRequestRef, RepoRef } from "../../forge/contract.ts";
import { FakeForge } from "../../forge/fake/fake-forge.ts";
import { createPrMergeWatcher, type PrMergeWatcher } from "./pr-merge-watcher.ts";

const REF: RepoRef = { forge: "fake", key: "acme/app" };
const HEAD = "fake-head-warren/run-1";
const NOW = new Date("2026-11-21T10:00:00.000Z");

function check(name: string, status: CheckRun["status"], conclusion: string | null): CheckRun {
	return { name, status, conclusion, jobId: null, detailsUrl: null };
}

const silentLogger = { warn: () => {}, error: () => {} };

async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!cond()) {
		if (Date.now() > deadline) throw new Error("waitFor timed out");
		await new Promise((resolve) => setTimeout(resolve, 1));
	}
}

describe("createPrMergeWatcher check summary (namphuongtran/warren#41)", () => {
	let db: WarrenDb;
	let repos: Repos;
	let forge: FakeForge;
	let pr: PullRequestRef;
	let runId: string;
	let watcher: PrMergeWatcher | undefined;

	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
		repos = createRepos(db);
		const project = await repos.projects.create({
			gitUrl: "fake://acme/app",
			localPath: "/data/projects/acme/app",
			defaultBranch: "main",
		});
		const run = await repos.runs.create({
			agentName: "a",
			projectId: project.id,
			prompt: "p",
			renderedAgentJson: {},
			trigger: "manual",
		});
		runId = run.id;
		forge = new FakeForge();
		const opened = await forge.openPullRequest(REF, {
			title: "t",
			body: "b",
			headBranch: "warren/run-1",
			baseBranch: "main",
		});
		if (!opened.ok) throw new Error("fake PR did not open");
		pr = opened.value;
	});
	afterEach(() => {
		watcher?.stop();
		watcher = undefined;
		db.close();
	});

	function build(sleep: () => Promise<void> = () => Promise.resolve()) {
		watcher = createPrMergeWatcher({
			repos,
			forge,
			logger: silentLogger,
			sleep,
			// Non-zero so the watcher calls `sleep` between polls (0 skips it).
			initialIntervalMs: 1,
			now: () => NOW,
		});
	}

	test("records the head commit's failing checks on a PR that merged with them", async () => {
		forge.setChecks(REF, HEAD, [
			check("Images, booted backend, authenticated e2e", "completed", "failure"),
		]);
		forge.markMerged(REF, pr);
		build();
		watcher?.adopt(runId, pr.webUrl);
		await waitFor(() => watcher?.watching === 0);
		const row = await repos.runs.get(runId);
		expect(row?.prState).toBe("merged");
		expect(row?.prChecks).toEqual({
			state: "failing",
			failing: ["Images, booted backend, authenticated e2e"],
			commit: HEAD,
			checkedAt: NOW.toISOString(),
		});
	});

	test("follows the checks as they change between polls", async () => {
		forge.setChecks(REF, HEAD, [check("e2e", "in_progress", null)]);
		const seen: (string | undefined)[] = [];
		build(async () => {
			seen.push((await repos.runs.get(runId))?.prChecks?.state);
			forge.setChecks(REF, HEAD, [check("e2e", "completed", "failure")]);
			forge.markMerged(REF, pr);
		});
		watcher?.adopt(runId, pr.webUrl);
		await waitFor(() => watcher?.watching === 0);
		expect(seen).toEqual(["pending"]);
		const row = await repos.runs.get(runId);
		expect(row?.prChecks?.state).toBe("failing");
		expect(row?.prChecks?.failing).toEqual(["e2e"]);
	});

	test("a check read that throws is logged and the watch still settles the PR", async () => {
		forge.markMerged(REF, pr);
		const warned: string[] = [];
		watcher = createPrMergeWatcher({
			repos,
			forge,
			logger: { warn: (_obj, msg) => void warned.push(msg), error: () => {} },
			checksReader: () => Promise.reject(new Error("boom")),
			sleep: () => Promise.resolve(),
			initialIntervalMs: 0,
		});
		watcher.adopt(runId, pr.webUrl);
		await waitFor(() => watcher?.watching === 0);
		const row = await repos.runs.get(runId);
		expect(row?.prState).toBe("merged");
		expect(row?.prChecks).toBeNull();
		expect(warned).toEqual(["pr_merge_watch.checks_failed"]);
	});

	test("keeps reading checks still running when the PR merged, until they settle", async () => {
		forge.setChecks(REF, HEAD, [check("e2e", "in_progress", null)]);
		forge.markMerged(REF, pr);
		build(async () => {
			forge.setChecks(REF, HEAD, [check("e2e", "completed", "failure")]);
		});
		watcher?.adopt(runId, pr.webUrl);
		await waitFor(() => watcher?.watching === 0);
		const row = await repos.runs.get(runId);
		expect(row?.prState).toBe("merged");
		expect(row?.prChecks?.state).toBe("failing");
	});
});

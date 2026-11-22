import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { openDatabase, type WarrenDb } from "../db/client.ts";
import { createRepos, type Repos } from "../db/repos/index.ts";
import { agents } from "../db/schema.ts";
import type { ForgeCapabilities, PullRequestRef } from "../forge/contract.ts";
import { FakeForge } from "../forge/fake/fake-forge.ts";
import { DEFAULT_RUN_BRANCH_PREFIX } from "../runs/branch.ts";
import type { LoadedWarrenConfig } from "../warren-config/index.ts";
import { runTick } from "./tick.ts";

const NOW = new Date("2026-05-11T00:05:00.000Z");

function ciFixerConfig(): LoadedWarrenConfig {
	return {
		triggers: null,
		defaults: {
			ciFixer: {
				enabled: true,
				maxRetries: 2,
				cooldownMinutes: 10,
				logTailLines: 200,
				role: "pr-fixer",
			},
		},
		prTemplate: null,
		sourceFile: null,
		errors: [],
		warnings: [],
	};
}

function emptyConfig(): LoadedWarrenConfig {
	return {
		triggers: null,
		defaults: null,
		prTemplate: null,
		sourceFile: null,
		errors: [],
		warnings: [],
	};
}

/** Override a FakeForge capability flag (test seam — the flags are readonly). */
function withCapabilities(forge: FakeForge, over: Partial<ForgeCapabilities>): FakeForge {
	Object.defineProperty(forge, "capabilities", {
		value: { ...forge.capabilities, ...over },
	});
	return forge;
}

describe("runCiFixerPass (via runTick)", () => {
	let db: WarrenDb;
	let repos: Repos;
	let projectId: string;

	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
		db.drizzle
			.insert(agents)
			.values({
				name: "claude-code",
				renderedJson: { sections: {} },
				registeredAt: "2026-05-10T00:00:00.000Z",
				lastRefreshed: "2026-05-10T00:00:00.000Z",
			})
			.run();
		repos = createRepos(db);
		const project = await repos.projects.create({
			gitUrl: "https://github.com/x/y.git",
			localPath: "/data/projects/x/y",
			defaultBranch: "main",
		});
		projectId = project.id;
	});

	afterEach(async () => {
		await db.close();
	});

	/** The fake forge numbers PRs from 1; `openForgePr` opens #1. */
	const PR_URL = "fake://x/y/pulls/1";

	async function openPr(prUrl = PR_URL): Promise<string> {
		const opener = await repos.runs.create({
			agentName: "claude-code",
			projectId,
			prompt: "open the PR",
			renderedAgentJson: { sections: {} },
			trigger: "manual",
		});
		await repos.runs.markRunning(opener.id, NOW);
		await repos.runs.setPrUrl(opener.id, prUrl);
		return opener.id;
	}

	/** Open the opener run's PR on the fake forge, as reap's pr_open would. */
	async function openForgePr(forge: FakeForge, openerId: string): Promise<PullRequestRef> {
		const ref = forge.parseRepoRef(PR_URL);
		if (ref === null) throw new Error("fake forge must own fake:// urls");
		const opened = await forge.openPullRequest(ref, {
			title: "t",
			body: "b",
			headBranch: `${DEFAULT_RUN_BRANCH_PREFIX}/${openerId}`,
			baseBranch: "main",
		});
		if (!opened.ok) throw new Error("fake forge must open the PR");
		return opened.value;
	}

	test("dispatches a fixer for a failing PR and stamps a system event", async () => {
		const openerId = await openPr();

		// warren-0b49: the poller consumes the Forge seam — FakeForge owns
		// `fake://` urls and reports the seeded check runs for the head ref
		// (`${DEFAULT_RUN_BRANCH_PREFIX}/${runId}`).
		const forge = new FakeForge();
		await openForgePr(forge, openerId);
		const ref = forge.parseRepoRef(PR_URL);
		if (ref === null) throw new Error("fake forge must own fake:// urls");
		forge.setChecks(ref, `${DEFAULT_RUN_BRANCH_PREFIX}/${openerId}`, [
			{
				name: "test",
				status: "completed",
				conclusion: "failure",
				jobId: "1",
				detailsUrl: null,
			},
		]);
		const spawnCalls: { projectId: string; agentName: string; parentRunId: string }[] = [];

		await runTick({
			repos,
			now: () => NOW,
			loadWarrenConfig: async () => ciFixerConfig(),
			spawn: async () => ({ runId: "unused" }),
			ciFixer: {
				forge,
				spawn: async (i) => {
					spawnCalls.push({
						projectId: i.projectId,
						agentName: i.agentName,
						parentRunId: i.parentRunId,
					});
					return { runId: "run_fixer" };
				},
			},
		});

		expect(spawnCalls).toEqual([{ projectId, agentName: "pr-fixer", parentRunId: openerId }]);
		const events = await repos.events.listByRun(openerId);
		expect(events).toHaveLength(1);
		expect(events[0]?.kind).toBe("ci_fixer.dispatched");
		expect(events[0]?.stream).toBe("system");
		const payload = events[0]?.payloadJson as { prUrl: string; fixerRunId: string };
		expect(payload).toEqual({ prUrl: PR_URL, fixerRunId: "run_fixer" });
	});

	// namphuongtran/warren#59: a merged PR whose branch survived with red
	// checks costs one lifecycle read, one info line, and nothing after.
	test("records a merged PR once, logs not_open at info, and skips it on later ticks", async () => {
		const openerId = await openPr();
		const forge = new FakeForge();
		const ref = forge.parseRepoRef(PR_URL);
		if (ref === null) throw new Error("fake forge must own fake:// urls");
		forge.markMerged(ref, await openForgePr(forge, openerId));
		forge.setChecks(ref, `${DEFAULT_RUN_BRANCH_PREFIX}/${openerId}`, [
			{ name: "test", status: "completed", conclusion: "failure", jobId: "1", detailsUrl: null },
		]);
		const forgeCalls: string[] = [];
		const getPullRequest = forge.getPullRequest.bind(forge);
		forge.getPullRequest = ((r, pr) => {
			forgeCalls.push("getPullRequest");
			return getPullRequest(r, pr);
		}) as FakeForge["getPullRequest"];
		forge.listChecks = (async () => {
			forgeCalls.push("listChecks");
			throw new Error("listChecks must not be called for a merged PR");
		}) as FakeForge["listChecks"];
		const logs: { level: string; msg: string | undefined; reason: unknown }[] = [];
		const log =
			(level: string) =>
			(obj: Record<string, unknown>, msg?: string): void => {
				logs.push({ level, msg, reason: obj.reason });
			};
		let spawned = 0;
		const tick = () =>
			runTick({
				repos,
				now: () => NOW,
				loadWarrenConfig: async () => ciFixerConfig(),
				spawn: async () => ({ runId: "unused" }),
				logger: { info: log("info"), warn: log("warn"), error: log("error") },
				ciFixer: {
					forge,
					spawn: async () => {
						spawned += 1;
						return { runId: "run_fixer" };
					},
				},
			});

		await tick();
		await tick();

		expect(forgeCalls).toEqual(["getPullRequest"]);
		expect(spawned).toBe(0);
		expect(logs.filter((l) => l.msg?.startsWith("scheduler.ci_fixer"))).toEqual([
			{ level: "info", msg: "scheduler.ci_fixer_skipped", reason: "not_open" },
		]);
		expect((await repos.runs.require(openerId)).prState).toBe("merged");
	});

	test("is a no-op when the project hasn't opted in", async () => {
		const openerId = await openPr();

		let spawned = 0;
		await runTick({
			repos,
			now: () => NOW,
			loadWarrenConfig: async () => emptyConfig(),
			spawn: async () => ({ runId: "unused" }),
			ciFixer: {
				forge: new FakeForge(),
				spawn: async () => {
					spawned += 1;
					return { runId: "run_fixer" };
				},
			},
		});

		expect(spawned).toBe(0);
		expect(await repos.events.listByRun(openerId)).toHaveLength(0);
	});

	// warren-0b49 (forge-contract.md §5): a forge without checkRuns keeps the
	// poller IDLE and emits ONE notice per project — never a per-PR per-tick
	// error stream.
	test("capabilities.checkRuns false keeps the poller idle with one gated notice per project", async () => {
		const openerId = await openPr();
		const forge = withCapabilities(new FakeForge(), { checkRuns: false });
		let listChecksCalls = 0;
		forge.listChecks = (async () => {
			listChecksCalls += 1;
			throw new Error("listChecks must not be called when checkRuns is false");
		}) as FakeForge["listChecks"];

		const notices: string[] = [];
		const seen = new Set<string>();
		let spawned = 0;
		const tick = () =>
			runTick({
				repos,
				now: () => NOW,
				loadWarrenConfig: async () => ciFixerConfig(),
				spawn: async () => ({ runId: "unused" }),
				noticeGate: {
					shouldNotify: (key) => {
						if (seen.has(key)) return false;
						seen.add(key);
						notices.push(key);
						return true;
					},
					clearNotice: () => {},
				},
				ciFixer: {
					forge,
					spawn: async () => {
						spawned += 1;
						return { runId: "run_fixer" };
					},
				},
			});

		await tick();
		await tick();

		expect(listChecksCalls).toBe(0);
		expect(spawned).toBe(0);
		expect(await repos.events.listByRun(openerId)).toHaveLength(0);
		expect(notices).toEqual([`ci_fixer_unsupported:${projectId}`]);
	});
});

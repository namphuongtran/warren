import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { WarrenDb } from "../../db/client.ts";
import type { Repos } from "../../db/repos/index.ts";
import { defaultSpawn } from "../../projects/clone.ts";
import { createGitFixture, type GitFixture } from "../../projects/git-fixture.test-helpers.ts";
import type { FakeProviderCall } from "../../runtime/fake/fake-provider.ts";
import { createWarrenConfigCache } from "../../warren-config/index.ts";
import { spawnRun } from "./index.ts";
import { makeAgentJson, makeSandboxClient, setupRepos } from "./test-helpers.ts";
import type { SpawnRunInput } from "./types.ts";

/**
 * namphuongtran/warren#169: a run cut from a non-default base (a `--ref` or
 * existing-branch repair, a continuation) reads every guardrail and the
 * `repoContext` from the default-branch tip, and takes only `qualityGate` and
 * `migrations.regenerateCommand` from its base. The shared clone stays on the
 * default branch throughout.
 */

const PROJECT_ID = "prj_branchcfg001";
const BRANCH = "feature/repair-me";
const MAIN_CONTEXT = "Route every task through the skill index first.";
const MAIN_CONFIG = [
	`repoContext: ${JSON.stringify(MAIN_CONTEXT)}`,
	"qualityGate: make check",
	"maxCostUsd: 5",
	"shortcutFlags:",
	"  protectedPaths:",
	'    - "infra/**"',
	"",
].join("\n");
/** A branch config that tries to change its gate, its context, and its guardrails. */
const BRANCH_CONFIG = [
	'repoContext: "branch context"',
	"qualityGate: bun run verify",
	"maxCostUsd: 999",
	"shortcutFlags:",
	"  protectedPaths: []",
	"",
].join("\n");

interface Harness {
	readonly db: WarrenDb;
	readonly repos: Repos;
	readonly fixture: GitFixture;
}

async function openHarness(): Promise<Harness> {
	const { db, repos } = await setupRepos();
	const fixture = createGitFixture();
	await repos.projects.create({
		id: PROJECT_ID,
		gitUrl: fixture.origin,
		localPath: fixture.clone,
		defaultBranch: "main",
	});
	return { db, repos, fixture };
}

/** Put `BRANCH` on origin with `files`, then land `MAIN_CONFIG` on main after it; returns main's tip. */
function cutBranchThenConfigMain(h: Harness, files: Readonly<Record<string, string>>): string {
	h.fixture.pushBranch(BRANCH, h.fixture.commitToOrigin(files, "branch"));
	return h.fixture.commitToOrigin({ ".warren/config.yaml": MAIN_CONFIG }, "main config");
}

function dispatch(h: Harness, extra: Partial<SpawnRunInput>) {
	const { client, calls } = makeSandboxClient();
	const result = spawnRun({
		repos: h.repos,
		runtimeProvider: client,
		agentName: "refactor-bot",
		projectId: PROJECT_ID,
		prompt: "fix the bug",
		projectsConfig: { root: h.fixture.dir, gitBinary: "git" },
		projectSpawn: defaultSpawn,
		warrenConfigs: createWarrenConfigCache(),
		...extra,
	});
	return { result, calls };
}

function sentPrompt(calls: readonly FakeProviderCall[]): string {
	const run = calls.find((c) => c.method === "POST" && c.path.endsWith("/runs"));
	return (run?.body as { prompt?: string } | undefined)?.prompt ?? "";
}

function sandboxBody(calls: readonly FakeProviderCall[]): { branch?: string; baseBranch?: string } {
	return (calls.find((c) => c.path === "/sandboxes")?.body ?? {}) as {
		branch?: string;
		baseBranch?: string;
	};
}

describe("spawnRun: a --ref dispatch reads config from the default branch (namphuongtran/warren#169)", () => {
	let h: Harness;
	beforeEach(async () => {
		h = await openHarness();
	});
	afterEach(async () => {
		h.fixture.cleanup();
		await h.db.close();
	});

	test("gives a branch cut before the config the default branch's repoContext and gate", async () => {
		const mainTip = cutBranchThenConfigMain(h, { "src/fix.ts": "export {};\n" });
		const { result, calls } = dispatch(h, { ref: BRANCH });
		const { run } = await result;

		expect(sentPrompt(calls)).toContain(MAIN_CONTEXT);
		expect(run.qualityGate).toBe("make check");
		expect(sandboxBody(calls).baseBranch).toBe(BRANCH);
		const context = await h.repos.dispatchContext.getByRunId(run.id);
		expect(context?.configCommit).toBe(mainTip);
	});

	test("takes the branch's gate but never its guardrails or repoContext", async () => {
		cutBranchThenConfigMain(h, { ".warren/config.yaml": BRANCH_CONFIG });
		const { result, calls } = dispatch(h, { ref: BRANCH });
		const { run } = await result;

		expect(run.qualityGate).toBe("bun run verify");
		expect(run.protectedPaths).toEqual(["infra/**"]);
		expect((await h.repos.dispatchContext.getByRunId(run.id))?.maxCostUsd).toBe(5);
		expect(sentPrompt(calls)).toContain(MAIN_CONTEXT);
		expect(sentPrompt(calls)).not.toContain("branch context");
	});

	test("leaves the shared clone and the project row on the default-branch tip", async () => {
		const mainTip = cutBranchThenConfigMain(h, { ".warren/config.yaml": BRANCH_CONFIG });
		const { result } = dispatch(h, { ref: BRANCH });
		await result;

		expect(h.fixture.git(h.fixture.clone, "symbolic-ref", "HEAD")).toBe("refs/heads/main");
		expect(h.fixture.git(h.fixture.clone, "rev-parse", "HEAD")).toBe(mainTip);
		expect((await h.repos.projects.require(PROJECT_ID)).lastHeadSha).toBe(mainTip);
		// The project-wide config cache every other reader uses is main's.
		const cache = createWarrenConfigCache();
		const envelope = await cache.get(PROJECT_ID, h.fixture.clone);
		expect(envelope.defaults?.qualityGate).toBe("make check");
	});
});

describe("spawnRun: repair and continuation runs take only the base's gate (namphuongtran/warren#169)", () => {
	let h: Harness;
	beforeEach(async () => {
		h = await openHarness();
	});
	afterEach(async () => {
		h.fixture.cleanup();
		await h.db.close();
	});

	test("an existing-branch repair run pushes to the branch with the branch's gate", async () => {
		cutBranchThenConfigMain(h, { ".warren/config.yaml": BRANCH_CONFIG });
		const { result, calls } = dispatch(h, { existingBranch: BRANCH });
		const { run } = await result;

		expect(sandboxBody(calls)).toMatchObject({ branch: BRANCH, baseBranch: BRANCH });
		expect(run.qualityGate).toBe("bun run verify");
		expect(sentPrompt(calls)).toContain(MAIN_CONTEXT);
	});

	test("a continuation bases on the parent's frozen branch and takes its gate", async () => {
		cutBranchThenConfigMain(h, { ".warren/config.yaml": BRANCH_CONFIG });
		const parent = await h.repos.runs.create({
			agentName: "refactor-bot",
			projectId: PROJECT_ID,
			prompt: "first pass",
			renderedAgentJson: makeAgentJson(),
			trigger: "manual",
		});
		await h.repos.runs.setBranch(parent.id, BRANCH);
		const { result, calls } = dispatch(h, { parentRunId: parent.id });
		const { run } = await result;

		expect(sandboxBody(calls).baseBranch).toBe(BRANCH);
		expect(run.qualityGate).toBe("bun run verify");
		expect(sentPrompt(calls)).toContain(MAIN_CONTEXT);
	});
});

describe("spawnRun: a --ref dispatch keeps untracked host-clone config (warren-540f mirror)", () => {
	let h: Harness;
	beforeEach(async () => {
		h = await openHarness();
	});
	afterEach(async () => {
		h.fixture.cleanup();
		await h.db.close();
	});

	test("injects the operator-local repoContext into a ref dispatch on a mirror", async () => {
		h.fixture.pushBranch(BRANCH, h.fixture.commitToOrigin({ "src/fix.ts": "export {};\n" }));
		// What `warren init` does for a mirror: config the origin never carries.
		mkdirSync(join(h.fixture.clone, ".warren"));
		writeFileSync(
			join(h.fixture.clone, ".warren/config.yaml"),
			`repoContext: ${JSON.stringify(MAIN_CONTEXT)}\nqualityGate: make check\n`,
		);
		const { result, calls } = dispatch(h, { ref: BRANCH });
		const { run } = await result;

		expect(sentPrompt(calls)).toContain(MAIN_CONTEXT);
		expect(run.qualityGate).toBe("make check");
	});
});

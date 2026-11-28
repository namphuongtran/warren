import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { WarrenDb } from "../../db/client.ts";
import type { Repos } from "../../db/repos/index.ts";
import { defaultSpawn } from "../../projects/clone.ts";
import { ProjectUnavailableError } from "../../projects/errors.ts";
import { createGitFixture, type GitFixture } from "../../projects/git-fixture.test-helpers.ts";
import type { FakeProviderCall } from "../../runtime/fake/fake-provider.ts";
import { createWarrenConfigCache, WarrenConfigInvalidError } from "../../warren-config/index.ts";
import { spawnRun } from "./index.ts";
import { makeSandboxClient, setupRepos } from "./test-helpers.ts";

/**
 * namphuongtran/warren#165: every dispatch reads committed `.warren/` config
 * from the default-branch tip fetched at dispatch time, never from whatever
 * the shared host clone happens to have checked out. Untracked operator-local
 * config in the host clone (mirror onboarding, warren-540f) still applies.
 */

const PROJECT_ID = "prj_cfgsource001";
const REPO_CONTEXT = "Route every task through the skill index first.";

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

async function closeHarness(h: Harness): Promise<void> {
	h.fixture.cleanup();
	await h.db.close();
}

function dispatch(
	h: Harness,
	extra: { baseCommit?: string; ref?: string; projectId?: string } = {},
) {
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

describe("spawnRun: committed config comes from the default-branch tip (namphuongtran/warren#165)", () => {
	let h: Harness;
	let staleSha: string;
	let tipSha: string;

	beforeEach(async () => {
		h = await openHarness();
		// The clone sits at the initial commit; the config lands on origin later.
		staleSha = h.fixture.git(h.fixture.clone, "rev-parse", "HEAD");
		tipSha = h.fixture.commitToOrigin({
			".warren/config.yaml": `repoContext: ${JSON.stringify(REPO_CONTEXT)}\n`,
		});
	});
	afterEach(async () => {
		await closeHarness(h);
	});

	test("injects the default-branch tip's repoContext into a pinned dispatch and leaves HEAD alone", async () => {
		const { result, calls } = dispatch(h, { baseCommit: staleSha });
		await result;

		expect(sentPrompt(calls)).toContain(REPO_CONTEXT);
		// warren-232d: the pinned dispatch never moves the shared clone's HEAD.
		expect(h.fixture.git(h.fixture.clone, "rev-parse", "HEAD")).toBe(staleSha);
		expect(tipSha).not.toBe(staleSha);
	});

	test("records the default-branch tip as a pinned dispatch's config commit", async () => {
		const { result } = dispatch(h, { baseCommit: staleSha });
		const { run } = await result;

		const context = await h.repos.dispatchContext.getByRunId(run.id);
		expect(context?.configCommit).toBe(tipSha);
	});

	test("injects the default-branch tip's repoContext into a dispatch on a branch older than the config", async () => {
		h.fixture.pushBranch("fix/old-pr", staleSha);
		const { result, calls } = dispatch(h, { ref: "fix/old-pr" });
		const { run } = await result;

		// The clone now has the PR branch checked out, and that tree has no `.warren/`.
		expect(h.fixture.git(h.fixture.clone, "rev-parse", "HEAD")).toBe(staleSha);
		expect(sentPrompt(calls)).toContain(REPO_CONTEXT);
		expect((await h.repos.dispatchContext.getByRunId(run.id))?.configCommit).toBe(tipSha);
	});

	test("injects the repoContext into a default-branch dispatch and records the tip", async () => {
		const { result, calls } = dispatch(h);
		const { run } = await result;

		expect(sentPrompt(calls)).toContain(REPO_CONTEXT);
		expect((await h.repos.dispatchContext.getByRunId(run.id))?.configCommit).toBe(tipSha);
	});

	test("refuses a pinned dispatch when the default-branch tip carries a malformed config (warren-02aa)", async () => {
		h.fixture.commitToOrigin({ ".warren/config.yaml": "notAKnob: true\n" });
		const { result, calls } = dispatch(h, { baseCommit: staleSha });

		await expect(result).rejects.toBeInstanceOf(WarrenConfigInvalidError);
		expect(calls).toHaveLength(0);
		expect(await h.repos.runs.listAll()).toHaveLength(0);
	});

	test("refuses a dispatch when origin does not carry the project's default branch", async () => {
		await h.repos.projects.create({
			id: "prj_cfgsource002",
			gitUrl: h.fixture.origin,
			localPath: h.fixture.clone,
			defaultBranch: "trunk",
		});
		const { result, calls } = dispatch(h, { baseCommit: staleSha, projectId: "prj_cfgsource002" });

		await expect(result).rejects.toBeInstanceOf(ProjectUnavailableError);
		await expect(result).rejects.toThrow("default branch trunk is not on origin");
		expect(calls).toHaveLength(0);
		expect(await h.repos.runs.listAll()).toHaveLength(0);
	});
});

describe("spawnRun: untracked host-clone config still applies (warren-540f mirror)", () => {
	let h: Harness;
	let baseSha: string;

	beforeEach(async () => {
		h = await openHarness();
		baseSha = h.fixture.git(h.fixture.clone, "rev-parse", "HEAD");
		// What `warren init` does for a mirror: config the origin never carries.
		mkdirSync(join(h.fixture.clone, ".warren"));
		writeFileSync(
			join(h.fixture.clone, ".warren/config.yaml"),
			`repoContext: ${JSON.stringify(REPO_CONTEXT)}\n`,
		);
	});
	afterEach(async () => {
		await closeHarness(h);
	});

	test("injects the operator-local repoContext into a pinned dispatch on a mirror", async () => {
		const { result, calls } = dispatch(h, { baseCommit: baseSha });
		await result;

		expect(sentPrompt(calls)).toContain(REPO_CONTEXT);
	});

	test("injects the operator-local repoContext into a branch dispatch on a mirror", async () => {
		h.fixture.pushBranch("fix/upstream-pr", baseSha);
		const { result, calls } = dispatch(h, { ref: "fix/upstream-pr" });
		await result;

		expect(sentPrompt(calls)).toContain(REPO_CONTEXT);
	});
});

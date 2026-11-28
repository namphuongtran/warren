import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { WarrenDb } from "../../db/client.ts";
import type { Repos } from "../../db/repos/index.ts";
import { defaultSpawn } from "../../projects/clone.ts";
import { createGitFixture, type GitFixture } from "../../projects/git-fixture.test-helpers.ts";
import type { FakeProviderCall } from "../../runtime/fake/fake-provider.ts";
import { createWarrenConfigCache, WarrenConfigInvalidError } from "../../warren-config/index.ts";
import { spawnRun } from "./index.ts";
import { makeSandboxClient, setupRepos } from "./test-helpers.ts";

/**
 * namphuongtran/warren#165: a pinned dispatch reads `.warren/` from the same
 * place an unpinned one does, the host clone refreshed onto the default-branch
 * tip. The workspace is still cut at the pin, and the clone never detaches
 * onto it (warren-232d).
 */

const PROJECT_ID = "prj_pinnedcfg001";
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

function dispatchPinned(h: Harness, baseCommit: string) {
	const { client, calls } = makeSandboxClient();
	const result = spawnRun({
		repos: h.repos,
		runtimeProvider: client,
		agentName: "refactor-bot",
		projectId: PROJECT_ID,
		prompt: "fix the bug",
		baseCommit,
		projectsConfig: { root: h.fixture.dir, gitBinary: "git" },
		projectSpawn: defaultSpawn,
		warrenConfigs: createWarrenConfigCache(),
	});
	return { result, calls };
}

function sentPrompt(calls: readonly FakeProviderCall[]): string {
	const run = calls.find((c) => c.method === "POST" && c.path.endsWith("/runs"));
	return (run?.body as { prompt?: string } | undefined)?.prompt ?? "";
}

describe("spawnRun: a pinned dispatch reads the default-branch config (namphuongtran/warren#165)", () => {
	let h: Harness;
	let pinSha: string;
	let tipSha: string;

	beforeEach(async () => {
		h = await openHarness();
		// The clone sits at the pin; the config lands on origin's main afterwards.
		pinSha = h.fixture.git(h.fixture.clone, "rev-parse", "HEAD");
		tipSha = h.fixture.commitToOrigin({
			".warren/config.yaml": `repoContext: ${JSON.stringify(REPO_CONTEXT)}\n`,
		});
	});
	afterEach(async () => {
		h.fixture.cleanup();
		await h.db.close();
	});

	test("injects the default-branch tip's repoContext into a pinned dispatch", async () => {
		const { result, calls } = dispatchPinned(h, pinSha);
		await result;

		expect(sentPrompt(calls)).toContain(REPO_CONTEXT);
	});

	test("cuts the workspace at the pin and leaves the clone on the default branch (warren-232d)", async () => {
		const { result, calls } = dispatchPinned(h, pinSha);
		await result;

		const up = calls.find((c) => c.path === "/sandboxes")?.body as { baseBranch?: string };
		expect(up.baseBranch).toBe(pinSha);
		expect(h.fixture.git(h.fixture.clone, "symbolic-ref", "HEAD")).toBe("refs/heads/main");
		expect(h.fixture.git(h.fixture.clone, "rev-parse", "HEAD")).toBe(tipSha);
	});

	test("records the default-branch tip as the pinned run's config commit", async () => {
		const { result } = dispatchPinned(h, pinSha);
		const { run } = await result;

		const context = await h.repos.dispatchContext.getByRunId(run.id);
		expect(context?.configCommit).toBe(tipSha);
	});

	test("refuses a pinned dispatch when the tip carries a malformed config (warren-02aa)", async () => {
		h.fixture.commitToOrigin({ ".warren/config.yaml": "notAKnob: true\n" });
		const { result, calls } = dispatchPinned(h, pinSha);

		await expect(result).rejects.toBeInstanceOf(WarrenConfigInvalidError);
		expect(calls).toHaveLength(0);
		expect(await h.repos.runs.listAll()).toHaveLength(0);
	});
});

describe("spawnRun: a pinned dispatch keeps untracked host-clone config (warren-540f mirror)", () => {
	let h: Harness;

	beforeEach(async () => {
		h = await openHarness();
	});
	afterEach(async () => {
		h.fixture.cleanup();
		await h.db.close();
	});

	test("injects the operator-local repoContext into a pinned dispatch on a mirror", async () => {
		// What `warren init` does for a mirror: config the origin never carries.
		mkdirSync(join(h.fixture.clone, ".warren"));
		writeFileSync(
			join(h.fixture.clone, ".warren/config.yaml"),
			`repoContext: ${JSON.stringify(REPO_CONTEXT)}\n`,
		);
		const pinSha = h.fixture.git(h.fixture.clone, "rev-parse", "HEAD");
		const { result, calls } = dispatchPinned(h, pinSha);
		await result;

		expect(sentPrompt(calls)).toContain(REPO_CONTEXT);
	});
});

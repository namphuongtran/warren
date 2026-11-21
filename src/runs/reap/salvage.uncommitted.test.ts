/**
 * warren-cd3b follow-up (namphuongtran/warren#8): a dropped commit leaves the
 * agent's work as a DIRTY tree with zero commits ahead. `salvageWorkspace`
 * with `includeUncommitted` folds that tree onto a throwaway ref first, so the
 * rescue ref and the bundle both carry it. Driven against real git repos: the
 * claim under test is that the captured artifact contains the dirty file.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitRepoContextScrubEnv } from "../../bot-identity.ts";
import { gitFixtureEnv } from "../../workspace/git/test-fixture.ts";
import { salvageWorkspace } from "./salvage.ts";
import type { ReapExec, ReapFs } from "./types.ts";
import { defaultExec, defaultFs } from "./util.ts";

// warren-cfa7: the pre-commit hook exports GIT_DIR / GIT_INDEX_FILE, so every
// spawn here (test-side and through the code under test) drops inherited
// GIT_* and pins discovery below the fixture root.
function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd, env: gitFixtureEnv(cwd), encoding: "utf8" }).trim();
}

/**
 * Hermetic exec: `defaultExec` merges over process.env, so inherited GIT_* must
 * be unset explicitly; the env the code under test sets still applies.
 */
const exec: ReapExec = {
	run: (cmd, args, opts) =>
		defaultExec.run(cmd, args, {
			...opts,
			env: {
				...gitRepoContextScrubEnv(),
				...opts.env,
				GIT_CEILING_DIRECTORIES: gitFixtureEnv(opts.cwd).GIT_CEILING_DIRECTORIES,
			},
		}),
};

const fs: ReapFs = defaultFs;

describe("salvageWorkspace includeUncommitted (dropped commit)", () => {
	let root: string;
	let ws: string;
	let origin: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "warren-salvage-dirty-"));
		origin = join(root, "origin.git");
		ws = join(root, "ws");
		git(root, "init", "-q", "--bare", "-b", "main", origin);
		git(root, "clone", "-q", origin, ws);
		writeFileSync(join(ws, "tracked.txt"), "v1\n");
		git(ws, "add", "tracked.txt");
		git(ws, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "tracked");
		git(ws, "push", "-q", "origin", "HEAD:main");
		// The agent's uncommitted work: a modified tracked file + a new file,
		// plus harness scratch that is not agent work.
		writeFileSync(join(ws, "tracked.txt"), "v2\n");
		writeFileSync(join(ws, "new.ts"), "export const x = 1;\n");
		mkdirSync(join(ws, ".claude"));
		writeFileSync(join(ws, ".claude", "settings.local.json"), "{}\n");
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	test("the rescue ref on origin carries the dirty tree, authored by the warren bot", async () => {
		const out = await salvageWorkspace({
			runId: "run_dirty",
			workspacePath: ws,
			baseBranch: "main",
			includeUncommitted: true,
			exec,
			fs,
		});

		expect(out.rescueRef).toBe("warren/rescue/run_dirty");
		expect(git(origin, "show", "warren/rescue/run_dirty:new.ts")).toBe("export const x = 1;");
		expect(git(origin, "show", "warren/rescue/run_dirty:tracked.txt")).toBe("v2");
		expect(git(origin, "log", "-1", "--format=%ae", "warren/rescue/run_dirty")).toBe(
			"bot@warren.invalid",
		);
		// The capture never touched the agent's checkout: HEAD and the index stay put.
		expect(git(ws, "rev-parse", "HEAD")).toBe(git(origin, "rev-parse", "main"));
		expect(git(ws, "status", "--porcelain")).toContain("?? new.ts");
	});

	test("with no reachable origin the bundle carries the dirty tree, minus harness scratch", async () => {
		git(ws, "remote", "set-url", "origin", join(root, "missing.git"));
		const salvageDir = join(root, "salvage");

		const out = await salvageWorkspace({
			runId: "run_dirty",
			workspacePath: ws,
			baseBranch: "main",
			salvageDir,
			includeUncommitted: true,
			exec,
			fs,
		});

		expect(out.rescueRef).toBeNull();
		expect(out.bundlePath).toBe(join(salvageDir, "run_dirty.bundle"));
		// The bundle's prerequisite is the base, so restore it onto a base clone.
		const restored = join(root, "restored");
		git(root, "clone", "-q", origin, restored);
		git(restored, "fetch", "-q", out.bundlePath ?? "", "warren/rescue/run_dirty:rescued");
		expect(git(restored, "show", "rescued:new.ts")).toBe("export const x = 1;");
		expect(git(restored, "ls-tree", "-r", "--name-only", "rescued")).not.toContain(".claude/");
	});
});

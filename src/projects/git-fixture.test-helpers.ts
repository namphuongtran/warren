/**
 * A throwaway bare origin plus a warren host clone of it, driven by real git
 * (namphuongtran/warren#165). Tests push commits to the origin through a
 * scratch working copy, so the host clone falls behind the way a long-lived
 * project clone does between refreshes.
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export interface GitFixture {
	/** Root of the fixture; pass it as `ProjectsConfig.root`. */
	readonly dir: string;
	/** The bare origin. */
	readonly origin: string;
	/** The host clone warren refreshes and reads; the project row's `localPath`. */
	readonly clone: string;
	/** Commit `files` (repo-relative path → contents) onto origin's `main`; returns the sha. */
	commitToOrigin(files: Readonly<Record<string, string>>, message?: string): string;
	/** Point `refs/heads/<name>` on origin at `sha`. */
	pushBranch(name: string, sha: string): void;
	/** Run git in `cwd` and return trimmed stdout; throws on a non-zero exit. */
	git(cwd: string, ...args: string[]): string;
	cleanup(): void;
}

/** Isolate fixture git from the developer's global config (signing, hooks, aliases). */
const FIXTURE_GIT_ENV: Readonly<Record<string, string>> = {
	GIT_CONFIG_GLOBAL: "/dev/null",
	GIT_CONFIG_NOSYSTEM: "1",
	GIT_AUTHOR_NAME: "fixture",
	GIT_AUTHOR_EMAIL: "fixture@example.invalid",
	GIT_COMMITTER_NAME: "fixture",
	GIT_COMMITTER_EMAIL: "fixture@example.invalid",
};

/**
 * Build the origin with one initial commit on `main` and clone it. The clone
 * starts level with the origin; later `commitToOrigin` calls leave it behind.
 */
export function createGitFixture(): GitFixture {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "warren-git-fixture-")));
	const origin = join(dir, "origin.git");
	const work = join(dir, "work");
	const clone = join(dir, "clone");

	const git = (cwd: string, ...args: string[]): string => {
		const env: Record<string, string> = {};
		for (const [key, value] of Object.entries(process.env)) {
			if (value !== undefined && !key.startsWith("GIT_")) env[key] = value;
		}
		const proc = Bun.spawnSync(["git", ...args], { cwd, env: { ...env, ...FIXTURE_GIT_ENV } });
		if (proc.exitCode !== 0) {
			throw new Error(`git ${args.join(" ")} exited ${proc.exitCode}: ${proc.stderr.toString()}`);
		}
		return proc.stdout.toString().trim();
	};

	const commitToOrigin = (files: Readonly<Record<string, string>>, message = "update"): string => {
		for (const [path, contents] of Object.entries(files)) {
			const abs = join(work, path);
			mkdirSync(dirname(abs), { recursive: true });
			writeFileSync(abs, contents);
		}
		git(work, "add", "--all");
		git(work, "commit", "-q", "-m", message);
		git(work, "push", "-q", "origin", "HEAD:refs/heads/main");
		return git(work, "rev-parse", "HEAD");
	};

	git(dir, "init", "-q", "--bare", "-b", "main", origin);
	git(dir, "init", "-q", "-b", "main", work);
	git(work, "remote", "add", "origin", origin);
	commitToOrigin({ "README.md": "fixture\n" }, "initial");
	git(dir, "clone", "-q", origin, clone);

	return {
		dir,
		origin,
		clone,
		commitToOrigin,
		pushBranch: (name, sha) => git(work, "push", "-q", "origin", `${sha}:refs/heads/${name}`),
		git,
		cleanup: () => rmSync(dir, { recursive: true, force: true }),
	};
}

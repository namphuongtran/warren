import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { defaultSpawn, type SpawnFn } from "../../projects/clone.ts";
import { createGitFixture, type GitFixture } from "../../projects/git-fixture.test-helpers.ts";
import {
	appendMigrationCollisionNote,
	composeMigrationCollisionNote,
	detectMigrationJournalCollisions,
	findCollisions,
	MigrationPreflightError,
	type MigrationPreflightInput,
} from "./migration-preflight.ts";

/**
 * warren-1f03 / warren-4371: dispatch-time drizzle migration journal
 * preflight. Detection compares the branch's journal entries against fresh
 * main's; a branch migration whose index/tag also exists on main with a
 * different tag is a collision. Detection is read-only on the host: it never
 * runs a repository-defined script, never writes to the clone, and never
 * commits — the run regenerates inside its sandbox. Both sides come from git
 * objects, because the host clone stays on the default branch
 * (namphuongtran/warren#169).
 */

const SQLITE_DIR = "src/db/migrations";
const SQLITE_JOURNAL = `${SQLITE_DIR}/meta/_journal.json`;
const BRANCH = "feature/schema";

/** The only commands the host-side detection may run: read-only git plumbing. */
const READ_ONLY_GIT = new Set(["ls-tree", "cat-file"]);

function journal(entries: { idx: number; tag: string }[]): string {
	return JSON.stringify({
		version: "7",
		dialect: "sqlite",
		entries: entries.map((e) => ({ ...e, version: "6", when: 1, breakpoints: true })),
	});
}

/** The files one drizzle migration adds: its SQL and its snapshot. */
function migrationFiles(entries: { idx: number; tag: string }[]): Record<string, string> {
	const files: Record<string, string> = { [SQLITE_JOURNAL]: journal(entries) };
	for (const entry of entries) {
		files[`${SQLITE_DIR}/${entry.tag}.sql`] = `-- ${entry.tag}\n`;
		const snapshot = `${String(entry.idx).padStart(4, "0")}_snapshot.json`;
		files[`${SQLITE_DIR}/meta/${snapshot}`] = JSON.stringify({ tag: entry.tag });
	}
	return files;
}

/**
 * Put `branch` on origin's `BRANCH`, then move main to `main`, and bring the
 * clone to where a dispatch refresh leaves it: on main, with `BRANCH` a local
 * ref at origin's tip and never checked out.
 */
function divergeBranch(
	fixture: GitFixture,
	branch: Record<string, string>,
	main: Record<string, string> | null,
): void {
	fixture.pushBranch(BRANCH, fixture.commitToOrigin(branch, "branch"));
	if (main !== null) fixture.commitToOrigin(main, "main");
	fixture.git(fixture.clone, "fetch", "-q", "--prune", "origin");
	fixture.git(fixture.clone, "reset", "-q", "--hard", "origin/main");
	fixture.git(fixture.clone, "update-ref", `refs/heads/${BRANCH}`, `refs/remotes/origin/${BRANCH}`);
}

describe("findCollisions (warren-1f03)", () => {
	test("flags a branch entry whose idx exists on main with a different tag", () => {
		const found = findCollisions(
			SQLITE_DIR,
			[{ idx: 46, tag: "0046_branch" }],
			[{ idx: 46, tag: "0046_main" }],
		);
		expect(found).toEqual([
			{ migrationsDir: SQLITE_DIR, idx: 46, branchTag: "0046_branch", mainTag: "0046_main" },
		]);
	});

	test("passes a branch entry at a slot past main's tip", () => {
		const found = findCollisions(
			SQLITE_DIR,
			[{ idx: 47, tag: "0047_branch" }],
			[{ idx: 46, tag: "0046_main" }],
		);
		expect(found).toEqual([]);
	});
});

describe("detectMigrationJournalCollisions (warren-4371, namphuongtran/warren#169)", () => {
	let fixture: GitFixture;
	beforeEach(() => {
		fixture = createGitFixture();
	});
	afterEach(() => {
		fixture.cleanup();
	});

	function input(spawn: SpawnFn = defaultSpawn): MigrationPreflightInput {
		return { spawn, projectPath: fixture.clone, defaultBranch: "main", baseRef: BRANCH };
	}

	test("no migrations on the branch reports no collisions", async () => {
		divergeBranch(
			fixture,
			{ "README.md": "branch\n" },
			migrationFiles([{ idx: 0, tag: "0000_a" }]),
		);
		expect(await detectMigrationJournalCollisions(input())).toEqual({ collisions: [] });
	});

	test("a branch migration at a free slot past main's tip reports no collisions", async () => {
		divergeBranch(
			fixture,
			migrationFiles([
				{ idx: 45, tag: "0045_main" },
				{ idx: 46, tag: "0046_branch" },
			]),
			migrationFiles([{ idx: 45, tag: "0045_main" }]),
		);
		expect(await detectMigrationJournalCollisions(input())).toEqual({ collisions: [] });
	});

	test("reads the branch journal from the base ref while the clone sits on main", async () => {
		divergeBranch(
			fixture,
			migrationFiles([
				{ idx: 45, tag: "0045_main" },
				{ idx: 46, tag: "0046_branch" },
			]),
			migrationFiles([
				{ idx: 45, tag: "0045_main" },
				{ idx: 46, tag: "0046_main" },
			]),
		);

		const outcome = await detectMigrationJournalCollisions(input());

		expect(outcome.collisions).toEqual([
			{ migrationsDir: SQLITE_DIR, idx: 46, branchTag: "0046_branch", mainTag: "0046_main" },
		]);
	});

	test("a detected collision runs only read-only git plumbing and leaves the clone untouched", async () => {
		divergeBranch(
			fixture,
			migrationFiles([{ idx: 46, tag: "0046_branch" }]),
			migrationFiles([{ idx: 46, tag: "0046_main" }]),
		);
		const head = fixture.git(fixture.clone, "rev-parse", "HEAD");
		const calls: (readonly string[])[] = [];
		const recording: SpawnFn = (cmd, opts) => {
			calls.push(cmd);
			return defaultSpawn(cmd, opts);
		};

		const outcome = await detectMigrationJournalCollisions(input(recording));

		expect(outcome.collisions).toHaveLength(1);
		// No repository-defined script, no package manager, no commit: every
		// spawned command is `git ls-tree` or `git cat-file`.
		expect(calls.length).toBeGreaterThan(0);
		for (const cmd of calls) {
			expect(cmd[0]).toBe("git");
			expect(READ_ONLY_GIT.has(cmd[1] ?? "")).toBe(true);
		}
		const joined = calls.map((c) => c.join(" "));
		expect(joined.some((c) => c.includes("db:generate"))).toBe(false);
		expect(joined.some((c) => /\b(commit|add|bun|npm)\b/.test(c))).toBe(false);
		// The host clone is still clean on main.
		expect(fixture.git(fixture.clone, "rev-parse", "HEAD")).toBe(head);
		expect(fixture.git(fixture.clone, "symbolic-ref", "HEAD")).toBe("refs/heads/main");
		expect(fixture.git(fixture.clone, "status", "--porcelain")).toBe("");
	});

	test("a failed journal listing surfaces a typed MigrationPreflightError", async () => {
		const failing: SpawnFn = async () => ({ stdout: "", stderr: "not a git repo", exitCode: 128 });
		await expect(detectMigrationJournalCollisions(input(failing))).rejects.toBeInstanceOf(
			MigrationPreflightError,
		);
	});
});

describe("composeMigrationCollisionNote (warren-4371)", () => {
	const collisions = [
		{ migrationsDir: SQLITE_DIR, idx: 46, branchTag: "0046_branch", mainTag: "0046_main" },
	];

	test("quotes the project's configured regenerate command for the agent", () => {
		const note = composeMigrationCollisionNote(collisions, "main", "bun run db:generate");
		expect(note).toContain("`0046_branch` (idx 46) collides with `0046_main` on `origin/main`");
		expect(note).toContain("run `bun run db:generate`");
		expect(note).toContain("Warren did not modify the branch");
	});

	test("imposes no command convention when the project configures none", () => {
		const note = composeMigrationCollisionNote(collisions, "trunk", undefined);
		expect(note).toContain("run this project's migration generator");
		expect(note).not.toContain("db:generate");
		expect(note).toContain("`origin/trunk`");
	});

	test("appendMigrationCollisionNote is the identity when there is no note", () => {
		expect(appendMigrationCollisionNote("prompt", null)).toBe("prompt");
		expect(appendMigrationCollisionNote("prompt", "note")).toBe("prompt\n\n---\n\nnote");
	});
});

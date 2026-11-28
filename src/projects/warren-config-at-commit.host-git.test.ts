import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defaultSpawn } from "./clone.ts";
import { ProjectUnavailableError } from "./errors.ts";
import { createGitFixture, type GitFixture } from "./git-fixture.test-helpers.ts";
import { loadWarrenConfigAtCommit } from "./warren-config-at-commit.ts";

describe("loadWarrenConfigAtCommit (namphuongtran/warren#165)", () => {
	let fixture: GitFixture;

	beforeEach(() => {
		fixture = createGitFixture();
	});
	afterEach(() => {
		fixture.cleanup();
	});

	/** Commit `files` in the host clone itself and return the new sha. */
	function commitInClone(files: Readonly<Record<string, string>>): string {
		for (const [path, contents] of Object.entries(files)) {
			const abs = join(fixture.clone, path);
			mkdirSync(join(abs, ".."), { recursive: true });
			writeFileSync(abs, contents);
		}
		fixture.git(fixture.clone, "add", "--all");
		fixture.git(fixture.clone, "commit", "-q", "-m", "config");
		return fixture.git(fixture.clone, "rev-parse", "HEAD");
	}

	function load(commit: string) {
		return loadWarrenConfigAtCommit({
			config: { root: fixture.dir, gitBinary: "git" },
			localPath: fixture.clone,
			commit,
			spawn: defaultSpawn,
		});
	}

	test("reads the committed config, not the working tree", async () => {
		const commit = commitInClone({ ".warren/config.yaml": 'repoContext: "committed"\n' });
		writeFileSync(join(fixture.clone, ".warren/config.yaml"), 'repoContext: "edited on disk"\n');

		const loaded = await load(commit);

		expect(loaded.defaults?.repoContext).toBe("committed");
		expect(loaded.sourceFile).toBe(".warren/config.yaml");
		expect(loaded.errors).toEqual([]);
	});

	test("reports every field null when neither the commit nor the clone has .warren", async () => {
		const commit = fixture.git(fixture.clone, "rev-parse", "HEAD");

		const loaded = await load(commit);

		expect(loaded).toEqual({
			triggers: null,
			defaults: null,
			prTemplate: null,
			sourceFile: null,
			errors: [],
			warnings: [],
		});
	});

	test("applies an untracked file the commit does not carry (mirror onboarding, warren-540f)", async () => {
		// `warren init` writes operator-local config into the host clone, untracked.
		mkdirSync(join(fixture.clone, ".warren"));
		writeFileSync(join(fixture.clone, ".warren/config.yaml"), 'repoContext: "operator-local"\n');
		const commit = fixture.git(fixture.clone, "rev-parse", "HEAD");

		const loaded = await load(commit);

		expect(loaded.defaults?.repoContext).toBe("operator-local");
		expect(loaded.sourceFile).toBe(".warren/config.yaml");
	});

	test("prefers the commit's file over an untracked copy at the same path", async () => {
		const base = fixture.git(fixture.clone, "rev-parse", "HEAD");
		const commit = commitInClone({ ".warren/config.yaml": 'repoContext: "committed"\n' });
		// Back on the base commit the file is gone from the index, so a copy is untracked.
		fixture.git(fixture.clone, "checkout", "-q", base);
		mkdirSync(join(fixture.clone, ".warren"), { recursive: true });
		writeFileSync(join(fixture.clone, ".warren/config.yaml"), 'repoContext: "operator-local"\n');

		const loaded = await load(commit);

		expect(loaded.defaults?.repoContext).toBe("committed");
	});

	test("reports a malformed committed file as an error against that file", async () => {
		const commit = commitInClone({ ".warren/config.yaml": "notAKnob: true\n" });

		const loaded = await load(commit);

		expect(loaded.defaults).toBeNull();
		expect(loaded.errors.map((err) => err.file)).toEqual([".warren/config.yaml"]);
	});

	test("does not follow a committed symlink", async () => {
		writeFileSync(join(fixture.clone, "elsewhere.yaml"), 'repoContext: "via link"\n');
		mkdirSync(join(fixture.clone, ".warren"));
		symlinkSync("../elsewhere.yaml", join(fixture.clone, ".warren/config.yaml"));
		fixture.git(fixture.clone, "add", "--all");
		fixture.git(fixture.clone, "commit", "-q", "-m", "link");
		const commit = fixture.git(fixture.clone, "rev-parse", "HEAD");

		const loaded = await load(commit);

		expect(loaded.defaults).toBeNull();
		expect(loaded.errors.map((err) => err.file)).toEqual([".warren/config.yaml"]);
		// The operator sees why, rather than a schema error about the link text.
		expect(loaded.errors[0]?.message).toContain("not a regular file");
	});

	test("throws when the commit is not in the clone", async () => {
		await expect(load("0".repeat(40))).rejects.toBeInstanceOf(ProjectUnavailableError);
	});
});

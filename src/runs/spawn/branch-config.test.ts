import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { defaultSpawn } from "../../projects/clone.ts";
import { createGitFixture, type GitFixture } from "../../projects/git-fixture.test-helpers.ts";
import { applyBranchDefaults, readBranchDefaults } from "./branch-config.ts";

/**
 * namphuongtran/warren#169: a run cut from a non-default base takes only the
 * branch-sourced keys from that base. Guardrails and `repoContext` stay the
 * default branch's.
 */

describe("applyBranchDefaults (namphuongtran/warren#169)", () => {
	const main = {
		qualityGate: "make check",
		repoContext: "main context",
		maxCostUsd: 5,
		shortcutFlags: { protectedPaths: ["infra/**"] },
		migrations: { regenerateCommand: "make migrations" },
	};

	test("keeps the default branch's defaults when the base commits no config", () => {
		expect(applyBranchDefaults(main, null)).toEqual({ defaults: main, taken: [] });
	});

	test("takes the base's quality gate and regenerate command", () => {
		const overlay = applyBranchDefaults(main, {
			qualityGate: "bun run verify",
			migrations: { regenerateCommand: "bun run db:generate" },
		});

		expect(overlay.defaults?.qualityGate).toBe("bun run verify");
		expect(overlay.defaults?.migrations?.regenerateCommand).toBe("bun run db:generate");
		expect(overlay.taken).toEqual(["qualityGate", "migrations.regenerateCommand"]);
	});

	test("ignores every guardrail and the repoContext the base sets", () => {
		const overlay = applyBranchDefaults(main, {
			repoContext: "branch context",
			maxCostUsd: 999,
			shortcutFlags: { protectedPaths: [] },
		});

		expect(overlay).toEqual({ defaults: main, taken: [] });
	});

	test("keeps the default branch's gate when the base predates it", () => {
		const overlay = applyBranchDefaults(main, { defaultModel: "sonnet" });

		expect(overlay.defaults?.qualityGate).toBe("make check");
		expect(overlay.taken).toEqual([]);
	});

	test("gives a branch gate to a project whose default branch sets no config", () => {
		const overlay = applyBranchDefaults(null, { qualityGate: "bun run verify" });

		expect(overlay.defaults).toEqual({ qualityGate: "bun run verify" });
	});
});

describe("readBranchDefaults (namphuongtran/warren#169)", () => {
	let fixture: GitFixture;
	beforeEach(() => {
		fixture = createGitFixture();
	});
	afterEach(() => {
		fixture.cleanup();
	});

	function read(baseSha: string) {
		return readBranchDefaults({
			spawn: defaultSpawn,
			gitBinary: "git",
			projectPath: fixture.clone,
			baseSha,
		});
	}

	function fetched(files: Readonly<Record<string, string>>): string {
		const sha = fixture.commitToOrigin(files);
		fixture.git(fixture.clone, "fetch", "-q", "origin");
		return sha;
	}

	test("reads the config the base commits, not the working tree's", async () => {
		const base = fetched({ ".warren/config.yaml": "qualityGate: bun run verify\n" });

		expect(await read(base)).toEqual({ defaults: { qualityGate: "bun run verify" }, errors: [] });
	});

	test("reads the legacy defaults.json when the base has no config.yaml", async () => {
		const base = fetched({ ".warren/defaults.json": '{"qualityGate":"make check"}\n' });

		expect((await read(base)).defaults).toEqual({ qualityGate: "make check" });
	});

	test("gives nothing for a base without a committed config (warren-540f mirror)", async () => {
		const base = fixture.git(fixture.clone, "rev-parse", "HEAD");

		expect(await read(base)).toEqual({ defaults: null, errors: [] });
	});

	test("reports a malformed base config instead of guessing", async () => {
		const base = fetched({ ".warren/config.yaml": "notAKnob: true\n" });
		const result = await read(base);

		expect(result.defaults).toBeNull();
		expect(result.errors.map((e) => e.file)).toEqual([".warren/config.yaml"]);
	});
});

import { describe, expect, test } from "bun:test";
import { scanShortcutFlags } from "./scan.ts";

/** A `git diff -U0` body for one modified file. */
function modified(path: string, hunks: string): string {
	return [
		`diff --git a/${path} b/${path}`,
		"index 1111111..2222222 100644",
		`--- a/${path}`,
		`+++ b/${path}`,
		hunks,
	].join("\n");
}

function scan(diff: string, extra: { protectedPaths?: string[]; commands?: string[] } = {}) {
	return scanShortcutFlags({
		diff,
		protectedPaths: extra.protectedPaths ?? [],
		commands: extra.commands ?? [],
	});
}

describe("scanShortcutFlags", () => {
	test("flags a suppression on an added line at its head line number", () => {
		const diff = modified(
			"src/a.ts",
			["@@ -10,0 +11,2 @@ function f() {", "+\t// @ts-ignore", "+\tconst x: number = y;"].join(
				"\n",
			),
		);
		expect(scan(diff).flags).toEqual([
			{ kind: "suppression", path: "src/a.ts", line: 11, detail: "@ts-ignore" },
		]);
	});

	test.each([
		["\t// @ts-expect-error wrong overload", "@ts-expect-error"],
		["// biome-ignore lint/suspicious/noExplicitAny: legacy", "biome-ignore"],
		["/* eslint-disable no-console */", "eslint-disable"],
		["\t// eslint-disable-next-line", "eslint-disable"],
		["import os  # noqa: F401", "noqa"],
		["x = f()  # type: ignore[arg-type]", "type: ignore"],
	])("flags the suppression in %p", (line, detail) => {
		const diff = modified("src/m.py", `@@ -1,0 +2 @@\n+${line}`);
		expect(scan(diff).flags).toEqual([{ kind: "suppression", path: "src/m.py", line: 2, detail }]);
	});

	test("ignores a suppression the diff removes", () => {
		const diff = modified("src/a.ts", "@@ -4 +3,0 @@\n-// @ts-ignore");
		expect(scan(diff).flags).toEqual([]);
	});

	test.each([
		['\ttest.skip("parses", () => {', ".skip"],
		['describe.skip("suite", () => {', ".skip"],
		['\tit.todo("handles empty input");', ".todo"],
		["\ttest.skip.each(cases)('%p', (c) => {", ".skip"],
		['\ttest.skipIf(isWindows)("paths", () => {', ".skipIf"],
		['    pytest.skip("needs network")', "pytest.skip("],
		['\txit("works", () => {', "xit("],
		['xdescribe("suite", () => {', "xdescribe("],
		['\ttest.only("focus", () => {', ".only"],
		['@pytest.mark.skip(reason="flaky")', "@pytest.mark.skip"],
		['@unittest.skip("later")', "@unittest.skip"],
	])("flags the skipped test in %p", (line, detail) => {
		const diff = modified("src/a.test.ts", `@@ -1,0 +5 @@\n+${line}`);
		expect(scan(diff).flags).toEqual([
			{ kind: "skipped_test", path: "src/a.test.ts", line: 5, detail },
		]);
	});

	test("does not read an ordinary skip() call in non-test code as a skipped test", () => {
		const diff = modified("src/stream.ts", "@@ -1,0 +5 @@\n+\treader.skip(4);");
		expect(scan(diff).flags).toEqual([]);
	});

	test("flags a deleted test file by its old path", () => {
		const diff = [
			"diff --git a/src/old.test.ts b/src/old.test.ts",
			"deleted file mode 100644",
			"index 3333333..0000000",
			"--- a/src/old.test.ts",
			"+++ /dev/null",
			"@@ -1,2 +0,0 @@",
			'-test("x", () => {',
			"-});",
		].join("\n");
		expect(scan(diff).flags).toEqual([
			{ kind: "deleted_test", path: "src/old.test.ts", line: null, detail: "test file deleted" },
		]);
	});

	test("does not flag a deleted file that is not a test", () => {
		const diff = [
			"diff --git a/src/old.ts b/src/old.ts",
			"deleted file mode 100644",
			"--- a/src/old.ts",
			"+++ /dev/null",
			"@@ -1 +0,0 @@",
			"-export const x = 1;",
		].join("\n");
		expect(scan(diff).flags).toEqual([]);
	});

	test("flags a test file that loses more assertions than it gains", () => {
		const diff = modified(
			"tests/test_api.py",
			[
				"@@ -10,3 +10 @@",
				"-    assert resp.status == 200",
				"-    assert resp.json() == {}",
				"-    self.assertEqual(a, b)",
				"+    assert resp.ok",
			].join("\n"),
		);
		expect(scan(diff).flags).toEqual([
			{
				kind: "assertions_removed",
				path: "tests/test_api.py",
				line: null,
				detail: "2 fewer assertions",
			},
		]);
	});

	test("does not flag a test file whose rewrite keeps its assertion count", () => {
		const diff = modified(
			"src/a.test.ts",
			["@@ -3 +3 @@", "-\texpect(a).toBe(1);", "+\texpect(a).toBe(2);"].join("\n"),
		);
		expect(scan(diff).flags).toEqual([]);
	});

	test("flags an edit to a file matching a protected glob, naming the glob", () => {
		const diff = modified(
			"scripts/coverage-budgets.json",
			["@@ -2 +2 @@", '-\t"lines": 91.2', '+\t"lines": 89.0'].join("\n"),
		);
		expect(scan(diff, { protectedPaths: ["**/*budget*.json"] }).flags).toEqual([
			{
				kind: "protected_file",
				path: "scripts/coverage-budgets.json",
				line: null,
				detail: "**/*budget*.json",
			},
		]);
	});

	test("flags a new file created at a protected path", () => {
		const diff = [
			"diff --git a/scripts/dups-allowlist.json b/scripts/dups-allowlist.json",
			"new file mode 100644",
			"--- /dev/null",
			"+++ b/scripts/dups-allowlist.json",
			"@@ -0,0 +1 @@",
			"+[]",
		].join("\n");
		const flags = scan(diff, { protectedPaths: ["scripts/*allowlist*.json"] }).flags;
		expect(flags.map((f) => [f.kind, f.path])).toEqual([
			["protected_file", "scripts/dups-allowlist.json"],
		]);
	});

	test("leaves files outside every protected glob unflagged", () => {
		const diff = modified("src/budget.ts", "@@ -1 +1 @@\n-a\n+b");
		expect(scan(diff, { protectedPaths: ["**/*budget*.json"] }).flags).toEqual([]);
	});

	test.each([
		['git commit --no-verify -m "wip"', "git commit --no-verify"],
		["cd /workspace && git commit -qn -m fix", "git commit -n"],
		["git -C /workspace push --no-verify origin HEAD", "git push --no-verify"],
		["bash -c 'git merge --no-verify topic'", "git merge --no-verify"],
		["timeout 60 git commit --no-verify -m x", "git commit --no-verify"],
		["env GIT_TRACE=1 /usr/bin/git push --no-verify", "git push --no-verify"],
	])("flags a hook bypass in %p", (command, detail) => {
		expect(scan("", { commands: [command] }).flags).toEqual([
			{ kind: "hook_bypass", path: null, line: null, detail },
		]);
	});

	test.each([
		['echo "never use git commit --no-verify"'],
		["git push -n origin HEAD"],
		["git commit -m 'skip --no-verify next time'"],
		["git commit -uno -m wip"],
		["git commit -mfunction"],
	])("does not read %p as a hook bypass", (command) => {
		expect(scan("", { commands: [command] }).flags).toEqual([]);
	});

	test("keeps the first 100 flags and counts the rest as omitted", () => {
		const lines = Array.from({ length: 130 }, () => "+// @ts-ignore").join("\n");
		const result = scan(modified("src/a.ts", `@@ -0,0 +1,130 @@\n${lines}`));
		expect(result.flags).toHaveLength(100);
		expect(result.flags[99]?.line).toBe(100);
		expect(result.omitted).toBe(30);
	});

	test("reads git's quoted header form and keeps each file's lines apart", () => {
		const diff = [
			'diff --git "a/src/caf\\303\\251.ts" "b/src/caf\\303\\251.ts"',
			"index 1111111..2222222 100644",
			'--- "a/src/caf\\303\\251.ts"',
			'+++ "b/src/caf\\303\\251.ts"',
			"@@ -1,0 +2 @@",
			"+// @ts-ignore",
			modified("src/b.ts", "@@ -1 +1 @@\n-x\n+y"),
		].join("\n");
		expect(scan(diff).flags).toEqual([
			{ kind: "suppression", path: "src/café.ts", line: 2, detail: "@ts-ignore" },
		]);
	});

	test("ignores suppression markers in prose and data files", () => {
		const diff = modified("docs/guide.md", "@@ -1,0 +2 @@\n+Avoid `// @ts-ignore` here.");
		expect(scan(diff).flags).toEqual([]);
	});

	test("does not read a deleted fixture or a spec document as a test file", () => {
		const deleted = (path: string) =>
			[
				`diff --git a/${path} b/${path}`,
				"deleted file mode 100644",
				`--- a/${path}`,
				"+++ /dev/null",
				"@@ -1 +0,0 @@",
				"-x",
			].join("\n");
		const diff = [deleted("tests/fixtures/data.json"), deleted("docs/api-spec.yaml")].join("\n");
		expect(scan(diff).flags).toEqual([]);
	});

	test("does not count an assertNever call as an assertion", () => {
		const diff = modified("src/a.test.ts", ["@@ -3 +2,0 @@", "-\tassertNever(kind);"].join("\n"));
		expect(scan(diff).flags).toEqual([]);
	});

	test("numbers added lines per hunk across a multi-hunk file", () => {
		const diff = modified(
			"src/a.ts",
			[
				"@@ -2 +2 @@",
				"-const a = 1;",
				"+const a = 2;",
				"@@ -40,0 +41,2 @@",
				"+const b = 3;",
				"+// biome-ignore lint/style: why",
			].join("\n"),
		);
		expect(scan(diff).flags).toEqual([
			{ kind: "suppression", path: "src/a.ts", line: 42, detail: "biome-ignore" },
		]);
	});
});

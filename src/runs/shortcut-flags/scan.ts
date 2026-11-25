/**
 * Shortcut-flag scan (namphuongtran/warren#37): cheap, deterministic
 * signs in a run's diff and git commands that the agent worked around a
 * gate instead of fixing the cause. Pure: reap hands in the diff text and
 * commands it already holds, and this module only pattern-matches.
 */

import type { RunQualityFlag, RunQualityFlags } from "../../core/wire.ts";
import { simpleCommandWords } from "../quality-gate/command.ts";
import { type DiffFile, parseUnifiedDiff } from "./diff.ts";

export interface ScanShortcutFlagsInput {
	/** `git diff --unified=0 base..head` output. */
	readonly diff: string;
	/** Globs over repo-relative paths whose edits are flagged. */
	readonly protectedPaths: readonly string[];
	/** Shell commands the agent ran, in order. */
	readonly commands: readonly string[];
}

/**
 * The protected-path globs a run uses when its project sets no
 * `shortcutFlags.protectedPaths`: the ratchet, budget, and allowlist files
 * a repo tightens over time. Kept small and language-neutral on purpose.
 */
export const DEFAULT_PROTECTED_PATHS: readonly string[] = [
	"**/*budget*.json",
	"**/*allowlist*.json",
	"**/*ratchet*.json",
];

/** A marker pattern and how to name what it matched. */
type Marker = readonly [RegExp, (m: RegExpExecArray) => string];

/** Suppression markers, matched case-sensitively anywhere on an added line. */
const SUPPRESSIONS: readonly Marker[] = [
	[/@ts-ignore\b/, () => "@ts-ignore"],
	[/@ts-expect-error\b/, () => "@ts-expect-error"],
	[/@ts-nocheck\b/, () => "@ts-nocheck"],
	[/\bbiome-ignore\b/, () => "biome-ignore"],
	[/\beslint-disable\b/, () => "eslint-disable"],
	[/#\s*noqa\b/, () => "noqa"],
	[/#\s*type:\s*ignore\b/, () => "type: ignore"],
];

/**
 * Test-skip markers. `.skip(` and friends are ordinary method names outside
 * a test suite, so these only count in a test file.
 */
const TEST_SKIPS: readonly Marker[] = [
	[/\b(?:test|it|describe|suite|context)\.(skipIf|skip|todo|only)\b/, (m) => `.${m[1]}`],
	[/\b(xit|xdescribe|xtest)\(/, (m) => `${m[1]}(`],
	[/\bpytest\.skip\(/, () => "pytest.skip("],
	[/@pytest\.mark\.skip/, () => "@pytest.mark.skip"],
	[/@unittest\.skip/, () => "@unittest.skip"],
];

/** Source files the line markers apply to; prose, data, and config never count. */
const CODE_FILE =
	/\.(?:[cm]?[jt]sx?|py|pyi|go|rb|java|kts?|rs|cs|php|swift|scala|c|cc|cpp|h|hpp|vue|svelte)$/;

const TEST_PATH =
	/(?:^|\/)(?:__tests__|tests?)\/|[._-](?:test|spec)\.[^/]+$|(?:^|\/)test_[^/]+\.py$/;

/** Whether `path` is source code (see {@link CODE_FILE}). */
export function isCodePath(path: string): boolean {
	return CODE_FILE.test(path);
}

/** Whether `path` is a test source file in the common JS, TS, Python, or Go layouts. */
export function isTestPath(path: string): boolean {
	return isCodePath(path) && TEST_PATH.test(path);
}

function firstMatch(text: string, patterns: readonly Marker[]): string | null {
	for (const [re, detail] of patterns) {
		const match = re.exec(text);
		if (match !== null) return detail(match);
	}
	return null;
}

function addedLineFlags(file: DiffFile): RunQualityFlag[] {
	const flags: RunQualityFlag[] = [];
	if (!isCodePath(file.path)) return flags;
	const isTest = isTestPath(file.path);
	for (const added of file.added) {
		const suppression = firstMatch(added.text, SUPPRESSIONS);
		if (suppression !== null) {
			flags.push({ kind: "suppression", path: file.path, line: added.line, detail: suppression });
		}
		const skip = isTest ? firstMatch(added.text, TEST_SKIPS) : null;
		if (skip !== null) {
			flags.push({ kind: "skipped_test", path: file.path, line: added.line, detail: skip });
		}
	}
	return flags;
}

/**
 * A line that asserts: `expect(`, `assert x`, `assert(`, `assert.equal(`,
 * `self.assertEqual(`, `.should`, or Go's `t.Error` / `t.Fatal`. TypeScript's
 * exhaustiveness helper `assertNever(` is not a test assertion.
 */
const ASSERTION =
	/\bexpect\(|\bassert(?!Never\b)(?:[A-Z]\w*)?(?:\s|\(|\.\w+\()|\.should\b|\bt\.(?:Error|Errorf|Fatal|Fatalf|Fail)\(/;

function countAssertions(lines: readonly string[]): number {
	return lines.filter((line) => ASSERTION.test(line)).length;
}

/** Whole-file flags for a test file: deleted outright, or left with fewer assertions. */
function testFileFlags(file: DiffFile): RunQualityFlag[] {
	if (!isTestPath(file.path)) return [];
	if (file.deleted) {
		return [{ kind: "deleted_test", path: file.path, line: null, detail: "test file deleted" }];
	}
	const lost =
		countAssertions(file.removed) - countAssertions(file.added.map((added) => added.text));
	if (lost <= 0) return [];
	return [
		{
			kind: "assertions_removed",
			path: file.path,
			line: null,
			detail: `${lost} fewer assertion${lost === 1 ? "" : "s"}`,
		},
	];
}

/** Git subcommands that run hooks `--no-verify` skips. */
const HOOKED_SUBCOMMANDS = new Set(["commit", "push", "merge", "am", "rebase", "cherry-pick"]);
/** Git global options that take a separate value word. */
const GIT_VALUE_OPTIONS = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace"]);

/** `git commit` short options whose value may follow in the same cluster (`-mfix`, `-uno`). */
const COMMIT_VALUE_LETTERS = new Set(["m", "F", "C", "c", "t", "u", "S"]);

/**
 * `git commit -n` / `-qn`: commit's short form of `--no-verify` (push's `-n`
 * is a dry run). The cluster ends at a letter that takes a value, so the
 * `n` in `-uno` or `-mfunction` is that value, not the flag.
 */
function isCommitShortNoVerify(subcommand: string, word: string): boolean {
	if (subcommand !== "commit" || !/^-[a-zA-Z]/.test(word)) return false;
	for (const letter of word.slice(1)) {
		if (letter === "n") return true;
		if (COMMIT_VALUE_LETTERS.has(letter)) return false;
	}
	return false;
}

/** Commands that run another command: `timeout 60 git …`, `env X=1 git …`. */
const COMMAND_WRAPPERS = new Set([
	"env",
	"command",
	"exec",
	"nice",
	"nohup",
	"sudo",
	"time",
	"timeout",
]);

function commandName(word: string): string {
	return word.slice(word.lastIndexOf("/") + 1);
}

/** A wrapper's own argument: an option, an env assignment, or a duration. */
function isWrapperArgument(word: string): boolean {
	return word.startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=/.test(word) || /^\d+[smhd]?$/.test(word);
}

/** Index of the `git` word behind any wrappers (`/usr/bin/git` counts), or -1. */
function gitWordIndex(words: readonly string[]): number {
	for (const [i, word] of words.entries()) {
		const name = commandName(word);
		if (name === "git") return i;
		if (!(COMMAND_WRAPPERS.has(name) || (i > 0 && isWrapperArgument(word)))) return -1;
	}
	return -1;
}

/** Index of git's subcommand word, past global options like `-C <dir>`. */
function subcommandIndex(words: readonly string[], gitIndex: number): number {
	let i = gitIndex + 1;
	while (i < words.length && (words[i] ?? "").startsWith("-")) {
		i += GIT_VALUE_OPTIONS.has(words[i] ?? "") ? 2 : 1;
	}
	return i;
}

/** The hook bypass in one simple command's words, as `git <sub> <flag>`, or null. */
function hookBypass(words: readonly string[]): string | null {
	const gitIndex = gitWordIndex(words);
	if (gitIndex === -1) return null;
	const i = subcommandIndex(words, gitIndex);
	const subcommand = words[i];
	if (subcommand === undefined || !HOOKED_SUBCOMMANDS.has(subcommand)) return null;
	for (const word of words.slice(i + 1)) {
		if (word === "--") return null;
		if (word === "--no-verify") return `git ${subcommand} --no-verify`;
		if (isCommitShortNoVerify(subcommand, word)) return "git commit -n";
	}
	return null;
}

/** One flag per distinct bypass the agent's commands contain. */
function commandFlags(commands: readonly string[]): RunQualityFlag[] {
	const seen = new Set<string>();
	for (const command of commands) {
		for (const words of simpleCommandWords(command)) {
			const bypass = hookBypass(words);
			if (bypass !== null) seen.add(bypass);
		}
	}
	return [...seen].map((detail) => ({ kind: "hook_bypass", path: null, line: null, detail }));
}

/** Compile the protected-path globs once; a glob Bun cannot compile is skipped. */
function compileGlobs(globs: readonly string[]): (path: string) => string | null {
	const compiled: { glob: string; matcher: Bun.Glob }[] = [];
	for (const glob of globs) {
		try {
			compiled.push({ glob, matcher: new Bun.Glob(glob) });
		} catch {
			// A pattern Bun cannot compile flags nothing; it is skipped silently.
		}
	}
	return (path) => compiled.find((c) => c.matcher.match(path))?.glob ?? null;
}

/** The most flags one run stores; the rest are counted in `omitted`. */
export const MAX_QUALITY_FLAGS = 100;

/**
 * Scan a run's diff and commands for shortcut signals. Command and
 * whole-file flags come before line flags, so the cap drops line flags
 * first. Never throws.
 */
export function scanShortcutFlags(input: ScanShortcutFlagsInput): RunQualityFlags {
	const protectedGlob = compileGlobs(input.protectedPaths);
	const files = parseUnifiedDiff(input.diff);
	const wholeFileFlags = files.flatMap((file): RunQualityFlag[] => {
		const glob = protectedGlob(file.path);
		const protectedFlag: RunQualityFlag[] =
			glob === null ? [] : [{ kind: "protected_file", path: file.path, line: null, detail: glob }];
		return [...protectedFlag, ...testFileFlags(file)];
	});
	const all = [
		...commandFlags(input.commands),
		...wholeFileFlags,
		...files.flatMap(addedLineFlags),
	];
	return {
		flags: all.slice(0, MAX_QUALITY_FLAGS),
		omitted: Math.max(0, all.length - MAX_QUALITY_FLAGS),
	};
}

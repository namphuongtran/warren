import { describe, expect, test } from "bun:test";
import { ValidationError } from "../core/errors.ts";
import type { SpawnOptions } from "../projects/clone.ts";
import { assertBranchAbsentOnRemote, validateNewBranchShape } from "./new-branch.ts";

/**
 * namphuongtran/warren#58: `newBranch` shape validation and the fail-closed
 * probe that the branch is still free on the push remote.
 */
describe("validateNewBranchShape", () => {
	const base = { targetBranch: undefined, existingBranch: undefined, defaultBranch: "main" };

	test("returns undefined when the field is absent or whitespace", () => {
		expect(validateNewBranchShape({ ...base, newBranch: undefined })).toBeUndefined();
		expect(validateNewBranchShape({ ...base, newBranch: "  " })).toBeUndefined();
	});

	test("returns the short name of a valid branch", () => {
		expect(validateNewBranchShape({ ...base, newBranch: "feat/412-web-push" })).toBe(
			"feat/412-web-push",
		);
		expect(validateNewBranchShape({ ...base, newBranch: "refs/heads/fix/7-x" })).toBe("fix/7-x");
	});

	test("rejects an invalid git ref", () => {
		expect(() => validateNewBranchShape({ ...base, newBranch: "feat/a b" })).toThrow(
			ValidationError,
		);
		expect(() => validateNewBranchShape({ ...base, newBranch: "feat/../x" })).toThrow(
			/not a valid git branch name/,
		);
	});

	test("rejects the project default branch", () => {
		expect(() => validateNewBranchShape({ ...base, newBranch: "refs/heads/main" })).toThrow(
			/project default branch/,
		);
	});

	test("rejects a combination with targetBranch or existingBranch", () => {
		expect(() =>
			validateNewBranchShape({ ...base, newBranch: "feat/1-a", targetBranch: "fix/pr" }),
		).toThrow(/cannot be combined with: targetBranch/);
		expect(() =>
			validateNewBranchShape({ ...base, newBranch: "feat/1-a", existingBranch: "fix/pr" }),
		).toThrow(/cannot be combined with: existingBranch/);
	});
});

describe("assertBranchAbsentOnRemote", () => {
	const probe = (stdout: string, exitCode = 0) => {
		const calls: (readonly string[])[] = [];
		const spawn = async (cmd: readonly string[], _opts: SpawnOptions) => {
			calls.push(cmd);
			return { stdout, stderr: "", exitCode };
		};
		return { calls, spawn };
	};
	const input = { gitUrl: "https://github.com/o/r.git", branch: "feat/1-a", cwd: "/tmp" };

	test("passes when the remote does not carry the branch", async () => {
		const { calls, spawn } = probe("");
		await expect(assertBranchAbsentOnRemote({ ...input, spawn })).resolves.toBeUndefined();
		expect(calls).toEqual([
			["git", "ls-remote", "--heads", "https://github.com/o/r.git", "refs/heads/feat/1-a"],
		]);
	});

	test("passes when only a longer branch name matches", async () => {
		const { spawn } = probe("abc\trefs/heads/x/feat/1-a\n");
		await expect(assertBranchAbsentOnRemote({ ...input, spawn })).resolves.toBeUndefined();
	});

	test("refuses a branch the remote already carries", async () => {
		const { spawn } = probe("abc123\trefs/heads/feat/1-a\n");
		await expect(assertBranchAbsentOnRemote({ ...input, spawn })).rejects.toThrow(
			/already exists on the push remote/,
		);
	});

	test("fails closed when the probe exits non-zero or throws", async () => {
		const { spawn } = probe("", 128);
		await expect(assertBranchAbsentOnRemote({ ...input, spawn })).rejects.toThrow(/exited 128/);
		const throwing = async () => {
			throw new Error("network down");
		};
		await expect(assertBranchAbsentOnRemote({ ...input, spawn: throwing })).rejects.toThrow(
			/network down/,
		);
	});
});

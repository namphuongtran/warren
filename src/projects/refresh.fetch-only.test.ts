import { describe, expect, test } from "bun:test";
import { ProjectUnavailableError } from "./errors.ts";
import { CFG, ok, recorder, TIP, TIP_REF } from "./refresh.test-helpers.ts";
import { refreshProjectClone } from "./refresh.ts";

describe("refreshProjectClone: fetch-only mode (warren-232d)", () => {
	const PIN = "0123456789abcdef0123456789abcdef01234567";
	const HEAD = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

	const BRANCH_REFSPEC = "+refs/heads/main:refs/remotes/origin/main";

	test("fetches the pinned sha, verifies it, and never moves HEAD (no checkout/reset)", async () => {
		const { spawn, calls } = recorder((cmd) => {
			if (cmd.includes(TIP_REF)) return ok(`${TIP}\n`);
			if (cmd[1] === "rev-parse") return ok(`${HEAD}\n`);
			return ok();
		});
		const result = await refreshProjectClone({
			config: CFG,
			localPath: "/data/projects/x/y",
			ref: "main",
			defaultBranch: "main",
			fetchCommit: PIN,
			spawn,
			exists: () => true,
		});

		// headSha is the clone's UNCHANGED HEAD; ref echoes the pin; configCommit
		// is the default-branch tip the same fetch brought down (namphuongtran/warren#165).
		expect(result).toEqual({
			headSha: HEAD,
			ref: PIN,
			features: { hasSeeds: true, hasMulch: true },
			configCommit: TIP,
		});
		expect(calls.map((c) => c.cmd.slice(0, 2))).toEqual([
			["git", "fetch"],
			["git", "cat-file"],
			["git", "rev-parse"],
			["git", "rev-parse"],
		]);
		expect(calls[0]?.cmd).toEqual(["git", "fetch", "origin", PIN, BRANCH_REFSPEC]);
		expect(calls[1]?.cmd).toEqual(["git", "cat-file", "-e", `${PIN}^{commit}`]);
		// Detached-HEAD safety: the shared clone's checked-out branch never moves.
		const verbs = calls.map((c) => c.cmd[1]);
		expect(verbs).not.toContain("checkout");
		expect(verbs).not.toContain("reset");
	});

	test("falls back to a full fetch when the server rejects the sha fetch (no allowReachableSHA1InWant)", async () => {
		const { spawn, calls } = recorder((cmd) => {
			if (cmd[1] === "fetch" && cmd.includes(PIN)) {
				return { stdout: "", stderr: "Server does not allow request", exitCode: 128 };
			}
			if (cmd[1] === "rev-parse") return ok(`${HEAD}\n`);
			return ok();
		});
		const result = await refreshProjectClone({
			config: CFG,
			localPath: "/data/projects/x/y",
			ref: "main",
			defaultBranch: "main",
			fetchCommit: PIN,
			spawn,
			exists: () => true,
		});

		expect(result.headSha).toBe(HEAD);
		expect(calls.map((c) => c.cmd)).toEqual([
			["git", "fetch", "origin", PIN, BRANCH_REFSPEC],
			["git", "fetch", "--prune", "origin"],
			["git", "cat-file", "-e", `${PIN}^{commit}`],
			["git", "rev-parse", "HEAD"],
			["git", "rev-parse", "--verify", "--quiet", TIP_REF],
		]);
	});

	test("aborts when the pinned commit is not on origin", async () => {
		const { spawn } = recorder((cmd) => {
			if (cmd[1] === "cat-file") {
				return { stdout: "", stderr: "bad object", exitCode: 128 };
			}
			if (cmd[1] === "rev-parse") return ok(`${HEAD}\n`);
			return ok();
		});
		await expect(
			refreshProjectClone({
				config: CFG,
				localPath: "/data/projects/x/y",
				ref: "main",
				defaultBranch: "main",
				fetchCommit: PIN,
				spawn,
				exists: () => true,
			}),
		).rejects.toBeInstanceOf(ProjectUnavailableError);
	});
});

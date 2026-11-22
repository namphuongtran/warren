import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { WarrenDb } from "../../db/client.ts";
import type { Repos } from "../../db/repos/index.ts";
import type { SpawnFn } from "../../projects/clone.ts";
import { spawnRun } from "./index.ts";
import { makeProvider, makeSandboxClient, setupRepos } from "./test-helpers.ts";

/**
 * namphuongtran/warren#58: `newBranch` names the fresh run branch. The base
 * stays the project default and no push target is set, so reap still opens
 * a PR. A branch the remote already carries is refused before the run row.
 */
describe("spawnRun: newBranch (namphuongtran/warren#58)", () => {
	let db: WarrenDb;
	let repos: Repos;

	beforeEach(async () => {
		({ db, repos } = await setupRepos());
	});
	afterEach(async () => {
		await db.close();
	});

	const remoteWith =
		(lsRemoteStdout: string): SpawnFn =>
		async (cmd) =>
			cmd.includes("ls-remote")
				? { stdout: lsRemoteStdout, stderr: "", exitCode: 0 }
				: { stdout: "", stderr: "", exitCode: 0 };

	test("uses the name as the run branch, cut from the default branch, with no push target", async () => {
		const { client, calls } = makeSandboxClient();
		const { run } = await spawnRun({
			repos,
			runtimeProvider: makeProvider(client),
			agentName: "refactor-bot",
			projectId: "prj_xxxxxxxxxxxx",
			prompt: "fix the web-push import",
			newBranch: "fix/946-web-push-import",
			projectsConfig: { root: "/data/projects", gitBinary: "git" },
			projectSpawn: remoteWith(""),
			refreshProjectFn: async (input) => {
				const updated = await repos.projects.recordRefresh({
					id: input.id,
					headSha: "feedface".repeat(5),
				});
				return { project: updated, headSha: "feedface".repeat(5), ref: input.ref ?? "main" };
			},
		});

		const reread = await repos.runs.require(run.id);
		expect(reread.branch).toBe("fix/946-web-push-import");
		expect(reread.targetBranch ?? undefined).toBeUndefined();
		const upBody = calls[0]?.body as { branch?: string; baseBranch?: string };
		expect(upBody.branch).toBe("fix/946-web-push-import");
		expect(upBody.baseBranch).toBe("main");
	});

	test("fails closed BEFORE the run row when the branch already exists on the remote", async () => {
		const { client } = makeSandboxClient();
		await expect(
			spawnRun({
				repos,
				runtimeProvider: makeProvider(client),
				agentName: "refactor-bot",
				projectId: "prj_xxxxxxxxxxxx",
				prompt: "fix the web-push import",
				newBranch: "fix/946-web-push-import",
				projectsConfig: { root: "/data/projects", gitBinary: "git" },
				projectSpawn: remoteWith("abc123\trefs/heads/fix/946-web-push-import\n"),
			}),
		).rejects.toThrow(/already exists on the push remote/);

		const all = await repos.runs.listAll();
		expect(all.every((r) => r.prompt !== "fix the web-push import")).toBe(true);
		expect(client.calls.length).toBe(0);
	});
});

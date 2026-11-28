import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { WarrenDb } from "../../db/client.ts";
import type { Repos } from "../../db/repos/index.ts";
import { spawnRun } from "./index.ts";
import { makeProvider, makeSandboxClient, setupRepos } from "./test-helpers.ts";
import type { SpawnLogger } from "./types.ts";

interface LogLine {
	readonly level: "info" | "warn" | "error";
	readonly obj: Record<string, unknown>;
	readonly msg?: string;
}

function makeRecordingLogger(): { logger: SpawnLogger; lines: LogLine[] } {
	const lines: LogLine[] = [];
	const make = (bindings: Record<string, unknown>): SpawnLogger => ({
		info: (obj, msg) => lines.push({ level: "info", obj: { ...bindings, ...obj }, msg }),
		warn: (obj, msg) => lines.push({ level: "warn", obj: { ...bindings, ...obj }, msg }),
		error: (obj, msg) => lines.push({ level: "error", obj: { ...bindings, ...obj }, msg }),
		child: (extra) => make({ ...bindings, ...(extra as Record<string, unknown>) }),
	});
	return { logger: make({}), lines };
}

function sandboxEnv(calls: ReadonlyArray<{ path: string; body?: unknown }>) {
	const up = calls.find((c) => c.path === "/sandboxes");
	return (up?.body as { env?: Record<string, string> } | undefined)?.env;
}

describe("spawnRun: agent git identity env (warren-4e36)", () => {
	let db: WarrenDb;
	let repos: Repos;

	beforeEach(async () => {
		({ db, repos } = await setupRepos());
	});
	afterEach(async () => {
		await db.close();
	});

	test("forwards WARREN_GIT_AUTHOR_* as the four GIT_* identity vars", async () => {
		// No runtime gets a gitconfig identity from warren — without these the
		// in-sandbox `git commit` fails with "Author identity unknown" exit 128.
		const { client, calls } = makeSandboxClient();
		await spawnRun({
			repos,
			runtimeProvider: makeProvider(client),
			agentName: "refactor-bot",
			projectId: "prj_xxxxxxxxxxxx",
			prompt: "fix it",
			serverEnv: {
				WARREN_GIT_AUTHOR_NAME: "warren",
				WARREN_GIT_AUTHOR_EMAIL: "op+warren@users.noreply.github.com",
			},
		});
		const env = sandboxEnv(calls);
		expect(env?.GIT_AUTHOR_NAME).toBe("warren");
		expect(env?.GIT_AUTHOR_EMAIL).toBe("op+warren@users.noreply.github.com");
		expect(env?.GIT_COMMITTER_NAME).toBe("warren");
		expect(env?.GIT_COMMITTER_EMAIL).toBe("op+warren@users.noreply.github.com");
	});

	test("a half-set pair injects the default identity, never half of the pair", async () => {
		const { client, calls } = makeSandboxClient();
		await spawnRun({
			repos,
			runtimeProvider: makeProvider(client),
			agentName: "refactor-bot",
			projectId: "prj_xxxxxxxxxxxx",
			prompt: "fix it",
			serverEnv: { WARREN_GIT_AUTHOR_NAME: "warren", WARREN_GIT_AUTHOR_EMAIL: "  " },
		});
		const env = sandboxEnv(calls);
		expect(env?.GIT_AUTHOR_NAME).toBe("warren-agent");
		expect(env?.GIT_AUTHOR_EMAIL).toBe("agent@warren.invalid");
		expect(env?.GIT_COMMITTER_NAME).toBe("warren-agent");
		expect(env?.GIT_COMMITTER_EMAIL).toBe("agent@warren.invalid");
	});

	test("unset vars inject the documented default on every runtime (namphuongtran/warren#160)", async () => {
		// Before the default, an unset pair left the run with no identity: the
		// agent's first commit failed and the agent invented an author.
		for (const runtime of ["local", "docker", "k8s"]) {
			const { client, calls } = makeSandboxClient();
			await spawnRun({
				repos,
				runtimeProvider: makeProvider(client),
				agentName: "refactor-bot",
				projectId: "prj_xxxxxxxxxxxx",
				prompt: "fix it",
				serverEnv: { WARREN_RUNTIME: runtime },
			});
			expect(sandboxEnv(calls)).toMatchObject({
				GIT_AUTHOR_NAME: "warren-agent",
				GIT_AUTHOR_EMAIL: "agent@warren.invalid",
				GIT_COMMITTER_NAME: "warren-agent",
				GIT_COMMITTER_EMAIL: "agent@warren.invalid",
			});
		}
	});
});

describe("spawnRun: half-set git identity surfacing (namphuongtran/warren#160)", () => {
	let db: WarrenDb;
	let repos: Repos;

	beforeEach(async () => {
		({ db, repos } = await setupRepos());
	});
	afterEach(async () => {
		await db.close();
	});

	test("a half-set pair warns exactly once per dispatch, on any runtime", async () => {
		for (const runtime of ["local", "docker", "k8s"]) {
			const { client } = makeSandboxClient();
			const { logger, lines } = makeRecordingLogger();
			await spawnRun({
				repos,
				runtimeProvider: makeProvider(client),
				agentName: "refactor-bot",
				projectId: "prj_xxxxxxxxxxxx",
				prompt: "fix it",
				logger,
				serverEnv: { WARREN_RUNTIME: runtime, WARREN_GIT_AUTHOR_EMAIL: "op@example.com" },
			});
			const warns = lines.filter((l) => l.obj.event === "spawn.git_identity_half_set");
			expect(warns).toHaveLength(1);
			expect(warns[0]?.level).toBe("warn");
			expect(warns[0]?.msg).toContain("WARREN_GIT_AUTHOR_NAME");
			expect(warns[0]?.obj.email).toBe("agent@warren.invalid");
			expect(warns[0]?.obj.run_id).toBeDefined();
		}
	});

	test("unset or configured vars emit no identity warn", async () => {
		for (const serverEnv of [
			{},
			{
				WARREN_GIT_AUTHOR_NAME: "warren",
				WARREN_GIT_AUTHOR_EMAIL: "op+warren@users.noreply.github.com",
			},
		]) {
			const { client } = makeSandboxClient();
			const { logger, lines } = makeRecordingLogger();
			await spawnRun({
				repos,
				runtimeProvider: makeProvider(client),
				agentName: "refactor-bot",
				projectId: "prj_xxxxxxxxxxxx",
				prompt: "fix it",
				logger,
				serverEnv,
			});
			expect(
				lines.filter((l) => l.obj.event?.toString().startsWith("spawn.git_identity")),
			).toHaveLength(0);
		}
	});
});

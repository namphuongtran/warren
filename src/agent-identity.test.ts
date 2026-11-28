import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	AGENT_GIT_IDENTITY_DEFAULT,
	agentGitIdentityEnv,
	resolveAgentGitIdentity,
} from "./agent-identity.ts";
import { WARREN_BOT_IDENTITY } from "./bot-identity.ts";

const CONFIGURED = {
	WARREN_GIT_AUTHOR_NAME: "acme-bot",
	WARREN_GIT_AUTHOR_EMAIL: "12345+acme-bot@users.noreply.github.com",
};

describe("resolveAgentGitIdentity", () => {
	test("returns the operator pair when both halves are set", () => {
		expect(resolveAgentGitIdentity(CONFIGURED)).toEqual({
			name: "acme-bot",
			email: "12345+acme-bot@users.noreply.github.com",
			source: "configured",
		});
	});

	test("trims the configured values", () => {
		const identity = resolveAgentGitIdentity({
			WARREN_GIT_AUTHOR_NAME: "  acme-bot ",
			WARREN_GIT_AUTHOR_EMAIL: " bot@acme.example  ",
		});
		expect(identity.name).toBe("acme-bot");
		expect(identity.email).toBe("bot@acme.example");
	});

	test("falls back to the documented default when both vars are unset", () => {
		expect(resolveAgentGitIdentity({})).toEqual({
			...AGENT_GIT_IDENTITY_DEFAULT,
			source: "default",
		});
	});

	test("treats whitespace-only values as unset", () => {
		const identity = resolveAgentGitIdentity({
			WARREN_GIT_AUTHOR_NAME: "  ",
			WARREN_GIT_AUTHOR_EMAIL: "\t",
		});
		expect(identity.source).toBe("default");
	});

	test("never half-applies a half-set pair", () => {
		for (const env of [
			{ WARREN_GIT_AUTHOR_NAME: "acme-bot" },
			{ WARREN_GIT_AUTHOR_EMAIL: "bot@acme.example" },
			{ WARREN_GIT_AUTHOR_NAME: "acme-bot", WARREN_GIT_AUTHOR_EMAIL: " " },
		]) {
			expect(resolveAgentGitIdentity(env)).toEqual({
				...AGENT_GIT_IDENTITY_DEFAULT,
				source: "half-set",
			});
		}
	});

	test("keeps the default distinct from the bookkeeping bot identity", () => {
		// Article VII: an auditor tells agent commits from chore(warren)
		// bookkeeping by author alone.
		expect(AGENT_GIT_IDENTITY_DEFAULT.name).not.toBe(WARREN_BOT_IDENTITY.name);
		expect(AGENT_GIT_IDENTITY_DEFAULT.email).not.toBe(WARREN_BOT_IDENTITY.email);
	});
});

describe("agentGitIdentityEnv", () => {
	test("sets author and committer to the configured pair", () => {
		expect(agentGitIdentityEnv(CONFIGURED)).toEqual({
			GIT_AUTHOR_NAME: "acme-bot",
			GIT_AUTHOR_EMAIL: "12345+acme-bot@users.noreply.github.com",
			GIT_COMMITTER_NAME: "acme-bot",
			GIT_COMMITTER_EMAIL: "12345+acme-bot@users.noreply.github.com",
		});
	});

	test("sets author and committer to the default when nothing is configured", () => {
		expect(agentGitIdentityEnv({})).toEqual({
			GIT_AUTHOR_NAME: "warren-agent",
			GIT_AUTHOR_EMAIL: "agent@warren.ai",
			GIT_COMMITTER_NAME: "warren-agent",
			GIT_COMMITTER_EMAIL: "agent@warren.ai",
		});
	});
});

describe("agentGitIdentityEnv in a sandbox with no git identity", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "warren-agent-identity-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	// A fresh run container: an empty HOME, no system or global gitconfig, and
	// `user.useConfigOnly` so git refuses to guess an identity from the host,
	// the way it does when the container has no usable hostname or user.
	function git(args: readonly string[], extraEnv: Record<string, string> = {}) {
		const proc = Bun.spawnSync(["git", "-c", "user.useConfigOnly=true", ...args], {
			cwd: dir,
			env: {
				PATH: process.env.PATH ?? "/usr/bin:/bin",
				HOME: dir,
				GIT_CONFIG_NOSYSTEM: "1",
				GIT_CONFIG_GLOBAL: join(dir, "absent-gitconfig"),
				...extraEnv,
			},
		});
		return {
			exitCode: proc.exitCode,
			stdout: proc.stdout.toString(),
			stderr: proc.stderr.toString(),
		};
	}

	test("commits on the first try under the default identity", () => {
		expect(git(["init", "-q"]).exitCode).toBe(0);
		// The control: without the run env, this commit is the one the pilot
		// agents could not make and then invented an author for.
		const bare = git(["commit", "-q", "--allow-empty", "-m", "control"]);
		expect(bare.exitCode).not.toBe(0);

		const run = git(["commit", "-q", "--allow-empty", "-m", "agent work"], agentGitIdentityEnv({}));
		expect(run.stderr).toBe("");
		expect(run.exitCode).toBe(0);
		const log = git(["log", "-1", "--format=%an <%ae>|%cn <%ce>"]);
		expect(log.stdout.trim()).toBe("warren-agent <agent@warren.ai>|warren-agent <agent@warren.ai>");
	});

	test("an in-sandbox git config user.name cannot change the author", () => {
		expect(git(["init", "-q"]).exitCode).toBe(0);
		const run = git(
			[
				"-c",
				"user.name=Claude",
				"-c",
				"user.email=noreply@anthropic.com",
				"commit",
				"-q",
				"--allow-empty",
				"-m",
				"agent work",
			],
			agentGitIdentityEnv(CONFIGURED),
		);
		expect(run.exitCode).toBe(0);
		const log = git(["log", "-1", "--format=%an <%ae>"]);
		expect(log.stdout.trim()).toBe("acme-bot <12345+acme-bot@users.noreply.github.com>");
	});
});

describe("agent identity install", () => {
	// namphuongtran/warren#160: the supervisor used to write the identity with
	// `git config --global`, which rewrote the operator's own ~/.gitconfig on a
	// host-run server. The identity now rides the run env only. This guard
	// fails if any server-side source passes `--global` to git again.
	test("no warren source writes a global gitconfig", () => {
		const srcRoot = import.meta.dir;
		const offenders: string[] = [];
		const glob = new Bun.Glob("**/*.ts");
		// src/ui is the browser bundle and never runs git; skipping it also
		// keeps the walk out of its node_modules.
		const roots = readdirSync(srcRoot, { withFileTypes: true })
			.filter((entry) => entry.isDirectory() && entry.name !== "ui")
			.map((entry) => join(srcRoot, entry.name));
		for (const root of roots) {
			for (const rel of glob.scanSync({ cwd: root })) {
				if (rel.endsWith(".test.ts") || rel.includes("node_modules/")) continue;
				const text = readFileSync(join(root, rel), "utf8");
				if (/["'`]--global["'`]/.test(text)) offenders.push(join(root, rel));
			}
		}
		expect(offenders).toEqual([]);
	});
});

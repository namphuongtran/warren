import { describe, expect, test } from "bun:test";
import type { SandboxProfile } from "../../sandbox/types.ts";
import type { AgentRuntimeAdapter } from "../adapters/index.ts";
import type { RunSpec } from "../contract.ts";
import { hasClaudeAuthEnv, prepareSpawn } from "./drive-prepare.ts";
import { LocalRunStore } from "./run-store.ts";

const PROFILE: SandboxProfile = {
	workspace: "/tmp/ws",
	home: "/tmp/home",
	readOnlyMounts: [],
	network: "open",
	allowedDomains: [],
	envPassthrough: ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"],
	setEnv: {},
	toolchainPaths: [],
};

function adapter(runtimeId: string): AgentRuntimeAdapter {
	return {
		runtimeId,
		harnessStatePrefixes: [],
		terminalErrorEnvelopeTypes: [],
		buildSpawnCommand: () => ({ argv: [runtimeId], stdin: "do it" }),
		parseEvents: () => [],
	} as AgentRuntimeAdapter;
}

function spec(runtimeId: string): RunSpec {
	return {
		runId: "run_prep1",
		originUrl: "https://github.com/o/r.git",
		branch: "warren/run_prep1",
		baseBranch: "main",
		hostClonePathHint: "/data/projects/o/r",
		runtimeId,
		prompt: "do it",
		mode: "batch",
		network: "open",
		seedFiles: [],
		env: {},
	};
}

/** Run prepareSpawn for one runtime and return the homes the credential copy targeted. */
async function forwardedHomes(
	runtimeId: string,
	profile: SandboxProfile,
	hostEnv: Record<string, string | undefined>,
): Promise<string[]> {
	const store = new LocalRunStore();
	const record = store.create({
		runId: "run_prep1",
		sandboxId: "local-run_prep1",
		workspacePath: "/tmp/ws",
		homePath: "/tmp/home",
		branch: "warren/run_prep1",
	});
	const homes: string[] = [];
	const prepared = await prepareSpawn(store, record, spec(runtimeId), profile, {
		registry: { get: (id) => (id === runtimeId ? adapter(runtimeId) : undefined) },
		forwardCredentials: async (home) => {
			homes.push(home);
		},
		hostEnv,
	});
	expect(prepared).not.toBeNull();
	return homes;
}

describe("hasClaudeAuthEnv", () => {
	test("sees a token set on the profile", () => {
		expect(hasClaudeAuthEnv({ ...PROFILE, setEnv: { CLAUDE_CODE_OAUTH_TOKEN: "t" } }, {})).toBe(
			true,
		);
	});

	test("sees a passthrough name whose host value is set", () => {
		expect(hasClaudeAuthEnv(PROFILE, { ANTHROPIC_API_KEY: "sk-ant-x" })).toBe(true);
	});

	test("ignores a host value whose name is not passed through", () => {
		expect(hasClaudeAuthEnv(PROFILE, { ANTHROPIC_AUTH_TOKEN: "gateway" })).toBe(false);
	});

	test("treats blank values as absent", () => {
		expect(hasClaudeAuthEnv({ ...PROFILE, setEnv: { ANTHROPIC_API_KEY: "  " } }, {})).toBe(false);
		expect(hasClaudeAuthEnv(PROFILE, { CLAUDE_CODE_OAUTH_TOKEN: "" })).toBe(false);
	});
});

describe("prepareSpawn host-credential fallback", () => {
	test("copies the host login into the run's $HOME when no auth env is present", async () => {
		expect(await forwardedHomes("claude-code", PROFILE, {})).toEqual(["/tmp/home"]);
	});

	test("skips the copy when CLAUDE_CODE_OAUTH_TOKEN reaches the run", async () => {
		expect(
			await forwardedHomes("claude-code", PROFILE, { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-x" }),
		).toEqual([]);
	});

	test("never copies for another runtime", async () => {
		expect(await forwardedHomes("pi", PROFILE, {})).toEqual([]);
	});
});

describe("prepareSpawn adapter-declared credential hand-off (namphuongtran/warren#17)", () => {
	async function handOff(
		profile: SandboxProfile,
		hostEnv: Record<string, string | undefined>,
	): Promise<{ homePath: string; openai: boolean; codex: boolean }[]> {
		const calls: { homePath: string; openai: boolean; codex: boolean }[] = [];
		const withHook: AgentRuntimeAdapter = {
			...adapter("codex"),
			forwardHostCredentials: async (ctx) => {
				calls.push({
					homePath: ctx.homePath,
					openai: ctx.hasEnv("OPENAI_API_KEY"),
					codex: ctx.hasEnv("CODEX_API_KEY"),
				});
			},
		};
		const store = new LocalRunStore();
		const record = store.create({
			runId: "run_prep2",
			sandboxId: "local-run_prep2",
			workspacePath: "/tmp/ws",
			homePath: "/tmp/home",
			branch: "warren/run_prep2",
		});
		const prepared = await prepareSpawn(store, record, spec("codex"), profile, {
			registry: { get: (id) => (id === "codex" ? withHook : undefined) },
			forwardCredentials: async () => {
				throw new Error("the claude-code copy must not run for codex");
			},
			hostEnv,
		});
		expect(prepared).not.toBeNull();
		return calls;
	}

	test("calls the adapter's hook with the run's private home", async () => {
		expect(await handOff(PROFILE, {})).toEqual([
			{ homePath: "/tmp/home", openai: false, codex: false },
		]);
	});

	test("tells the hook which credentials the run already carries", async () => {
		const profile = {
			...PROFILE,
			envPassthrough: ["OPENAI_API_KEY"],
			setEnv: { CODEX_API_KEY: "k" },
		};
		expect(await handOff(profile, { OPENAI_API_KEY: "sk-x" })).toEqual([
			{ homePath: "/tmp/home", openai: true, codex: true },
		]);
	});

	test("does not report a passthrough name the host env leaves blank", async () => {
		const profile = { ...PROFILE, envPassthrough: ["OPENAI_API_KEY"] };
		expect(await handOff(profile, { OPENAI_API_KEY: " " })).toEqual([
			{ homePath: "/tmp/home", openai: false, codex: false },
		]);
	});
});

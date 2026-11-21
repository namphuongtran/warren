import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexAdapter, encodeCodexPrompt } from "./codex.ts";
import { forwardCodexHostCredentials } from "./codex-credentials.ts";
import type { AdapterSpawnContext } from "./types.ts";

function spawnContext(extra: Partial<AdapterSpawnContext> = {}): AdapterSpawnContext {
	return {
		runId: "run_test",
		prompt: "fix the bug",
		pendingMessages: [],
		workspacePath: "/ws",
		...extra,
	};
}

/** Run the argv's `sh -c` shim and capture what the final `exec` would see. */
async function shimEnv(env: Record<string, string>): Promise<string> {
	const cmd = codexAdapter.buildSpawnCommand?.(spawnContext());
	const argv = cmd?.argv ?? [];
	expect(argv.slice(0, 2)).toEqual(["sh", "-c"]);
	const script = (argv[2] ?? "").replace(/exec codex "\$@"$/, 'printf %s "$CODEX_API_KEY"');
	const proc = Bun.spawn(["sh", "-c", script, ...argv.slice(3)], { env, stdout: "pipe" });
	await proc.exited;
	return new Response(proc.stdout).text();
}

describe("codexAdapter.buildSpawnCommand", () => {
	test("runs codex exec headless with JSONL output, Codex's own sandbox off, prompt on stdin", () => {
		const cmd = codexAdapter.buildSpawnCommand?.(spawnContext());
		const argv = cmd?.argv ?? [];
		expect(argv.slice(3)).toEqual([
			"codex",
			"exec",
			"--json",
			"--skip-git-repo-check",
			"--dangerously-bypass-approvals-and-sandbox",
			"-",
		]);
		expect(argv[2]).toEndWith('exec codex "$@"');
		expect(cmd?.stdin).toBe("fix the bug");
	});

	test("passes an OpenAI model as --model before the stdin marker", () => {
		const cmd = codexAdapter.buildSpawnCommand?.(
			spawnContext({ frontmatter: { provider: "openai", model: " gpt-5.3-codex " } }),
		);
		expect(cmd?.argv.slice(-3)).toEqual(["--model", "gpt-5.3-codex", "-"]);
	});

	test("leaves the model off for a provider Codex cannot speak", () => {
		const cmd = codexAdapter.buildSpawnCommand?.(
			spawnContext({ frontmatter: { provider: "anthropic", model: "claude-sonnet-5-5" } }),
		);
		expect(cmd?.argv).not.toContain("--model");
	});

	test("the shim lends OPENAI_API_KEY to CODEX_API_KEY only when CODEX_API_KEY is unset", async () => {
		expect(await shimEnv({ OPENAI_API_KEY: "sk-openai" })).toBe("sk-openai");
		expect(await shimEnv({ OPENAI_API_KEY: "sk-openai", CODEX_API_KEY: "sk-codex" })).toBe(
			"sk-codex",
		);
		expect(await shimEnv({})).toBe("");
	});

	test("never puts a credential on the argv", () => {
		const argv = codexAdapter.buildSpawnCommand?.(spawnContext())?.argv ?? [];
		expect(argv.join(" ")).not.toMatch(/sk-/);
	});
});

describe("encodeCodexPrompt / encodeInboxMessage", () => {
	test("folds pending steering after the prompt, tagged with its priority", () => {
		expect(
			encodeCodexPrompt("fix the bug", [{ body: "write tests first", priority: "high" }]),
		).toBe("fix the bug\n\n[STEERING] (priority: high) write tests first");
	});

	test("encodeInboxMessage renders the same steering block", () => {
		expect(codexAdapter.encodeInboxMessage?.([{ body: "stop", priority: "normal" }])).toEqual({
			stdin: "[STEERING] (priority: normal) stop",
		});
	});

	test("declares no mid-run steering: codex exec reads stdin once", () => {
		expect(codexAdapter.shouldCloseStdinOnEvent).toBeUndefined();
		expect(codexAdapter.encodeSteeringMessage).toBeUndefined();
	});
});

describe("codexAdapter.ignoredModelSelection", () => {
	test("names a non-OpenAI provider and what the run uses instead", () => {
		expect(
			codexAdapter.ignoredModelSelection?.({ provider: "anthropic", model: "claude-sonnet-5-5" }),
		).toMatchObject({ provider: "anthropic", model: "claude-sonnet-5-5" });
	});

	test("reports nothing for OpenAI or an unset provider", () => {
		expect(codexAdapter.ignoredModelSelection?.({ provider: "openai", model: "gpt-5.5" })).toBe(
			undefined,
		);
		expect(codexAdapter.ignoredModelSelection?.({ model: "gpt-5.5" })).toBeUndefined();
	});
});

describe("codexAdapter.parseEvents", () => {
	test("prices the terminal usage with the run's pinned model", () => {
		const events =
			codexAdapter.parseEvents?.(
				JSON.stringify({
					type: "turn.completed",
					usage: { input_tokens: 1_000_000, cached_input_tokens: 0, output_tokens: 0 },
				}),
				{ frontmatter: { provider: "openai", model: "gpt-5.3-codex" } },
			) ?? [];
		expect(events[0]?.payload).toMatchObject({ type: "result", total_cost_usd: 1.75 });
	});
});

describe("codexAdapter declarations", () => {
	test("puts nothing in the workspace, so it declares no harness state", () => {
		expect(codexAdapter.harnessStatePrefixes).toEqual([]);
	});

	test("its provider errors ride the shared result envelope", () => {
		expect(codexAdapter.terminalErrorEnvelopeTypes).toEqual(["result"]);
	});

	test("names the env it reads and the binary the sandbox must resolve", () => {
		expect(codexAdapter.envPassthrough?.(undefined)).toEqual([
			"OPENAI_API_KEY",
			"OPENAI_BASE_URL",
			"CODEX_API_KEY",
		]);
		expect(codexAdapter.cliBinaries).toEqual(["codex"]);
	});
});

describe("forwardCodexHostCredentials", () => {
	let root: string;
	let hostCodexHome: string;
	let runHome: string;

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), "codex-creds-"));
		hostCodexHome = join(root, "host-codex");
		runHome = join(root, "run-home");
		mkdirSync(hostCodexHome, { recursive: true });
		mkdirSync(runHome, { recursive: true });
	});

	afterEach(async () => {
		await rm(root, { recursive: true, force: true });
	});

	test("copies the host auth.json into the run's private HOME with owner-only mode", async () => {
		const hostAuth = join(hostCodexHome, "auth.json");
		await writeFile(hostAuth, '{"tokens":{"access_token":"a"}}');
		await forwardCodexHostCredentials(
			{ homePath: runHome, hasEnv: () => false },
			{ hostCodexHome },
		);
		const copied = join(runHome, ".codex", "auth.json");
		expect(await readFile(copied, "utf8")).toBe('{"tokens":{"access_token":"a"}}');
		expect((await stat(copied)).mode & 0o777).toBe(0o600);
		// The host file is read, never rewritten.
		expect(await readFile(hostAuth, "utf8")).toBe('{"tokens":{"access_token":"a"}}');
	});

	test("skips the copy when an API key in the env already authenticates the CLI", async () => {
		await writeFile(join(hostCodexHome, "auth.json"), "{}");
		await forwardCodexHostCredentials(
			{ homePath: runHome, hasEnv: (name) => name === "OPENAI_API_KEY" },
			{ hostCodexHome },
		);
		expect(await Bun.file(join(runHome, ".codex", "auth.json")).exists()).toBe(false);
	});

	test("is a no-op on a host that never logged in", async () => {
		await forwardCodexHostCredentials(
			{ homePath: runHome, hasEnv: () => false },
			{ hostCodexHome },
		);
		expect(await Bun.file(join(runHome, ".codex", "auth.json")).exists()).toBe(false);
	});
});

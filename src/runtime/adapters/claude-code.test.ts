/**
 * Ported from burrow's `src/runtime/claude-code.test.ts` (warren-7933).
 * Burrow's DB-row fakes collapse to the narrowed `AdapterSpawnContext` /
 * `SteeringMessage` shapes; the envPassthrough / buildResumeCommand /
 * credentialPaths suites stay behind in burrow (out of the lift's scope).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	CLAUDE_CODE_SANDBOX_TMPDIR,
	CLAUDE_CODE_SETTINGS_PATH,
	claudeCodeAdapter,
	claudeCodeBurrowTmpdir,
	claudeModelArgs,
	encodeClaudeStdin,
} from "./claude-code.ts";
import { forwardClaudeHostCredentials } from "./claude-credentials.ts";
import { parseJsonlClaude } from "./parsers/jsonl-claude.ts";
import type { AdapterSpawnContext, SteeringMessage } from "./types.ts";

function fakeMessage(extra: Partial<SteeringMessage> = {}): SteeringMessage {
	return {
		body: "stop and write tests first",
		priority: "high",
		...extra,
	};
}

function fakeSpawnContext(extra: Partial<AdapterSpawnContext> = {}): AdapterSpawnContext {
	return {
		runId: "run_test",
		prompt: "hello",
		pendingMessages: [],
		workspacePath: "/ws",
		...extra,
	};
}

describe("claudeCodeAdapter.buildSpawnCommand", () => {
	test("renders stream-json argv with the prompt + steering on stdin", () => {
		const cmd = claudeCodeAdapter.buildSpawnCommand?.(
			fakeSpawnContext({ prompt: "fix the bug", pendingMessages: [fakeMessage()] }),
		);
		expect(cmd?.argv).toEqual([
			"claude",
			"--print",
			"--input-format",
			"stream-json",
			"--output-format",
			"stream-json",
			"--verbose",
			"--dangerously-skip-permissions",
		]);
		// One user message, so the CLI runs one turn: it runs each stdin line as its
		// own turn, and reap finalizes at the first turn's `result`. The trailing
		// newline ends the line on a held-open stdin, where no EOF arrives.
		expect(cmd?.stdin).toBe(
			`${JSON.stringify({
				type: "user",
				message: {
					role: "user",
					content: [
						{ type: "text", text: "fix the bug" },
						{ type: "text", text: "[STEERING] (priority: high) stop and write tests first" },
					],
				},
			})}\n`,
		);
	});

	test("encodeClaudeStdin leaves the prompt block out when the prompt is empty", () => {
		expect(encodeClaudeStdin("", [fakeMessage({ body: "b", priority: "low" })])).toBe(
			`${JSON.stringify({
				type: "user",
				message: {
					role: "user",
					content: [{ type: "text", text: "[STEERING] (priority: low) b" }],
				},
			})}\n`,
		);
	});

	test("emits per-run TMPDIR pointing at .sandbox-tmp under the in-sandbox workspace (burrow-8452)", () => {
		const cmd = claudeCodeAdapter.buildSpawnCommand?.(
			fakeSpawnContext({ prompt: "p", workspacePath: "/host/ws" }),
		);
		expect(cmd?.env?.TMPDIR).toBe(claudeCodeBurrowTmpdir("/host/ws"));
	});
});

describe("claudeCodeAdapter.buildSpawnCommand model flag", () => {
	test("passes the frontmatter model as --model after the fixed flags", () => {
		const cmd = claudeCodeAdapter.buildSpawnCommand?.(
			fakeSpawnContext({ frontmatter: { provider: "anthropic", model: "claude-sonnet-4-6" } }),
		);
		expect(cmd?.argv.slice(-2)).toEqual(["--model", "claude-sonnet-4-6"]);
	});

	test("omits --model when the frontmatter names no model", () => {
		const cmd = claudeCodeAdapter.buildSpawnCommand?.(fakeSpawnContext({ frontmatter: {} }));
		expect(cmd?.argv).not.toContain("--model");
	});
});

describe("claudeModelArgs", () => {
	test("accepts a model with no provider", () => {
		expect(claudeModelArgs({ model: "opus" })).toEqual(["--model", "opus"]);
	});

	test("trims the model and treats a blank one as absent", () => {
		expect(claudeModelArgs({ model: "  claude-opus-4-8  " })).toEqual([
			"--model",
			"claude-opus-4-8",
		]);
		expect(claudeModelArgs({ model: "   " })).toEqual([]);
	});

	test("leaves the flag off for a non-Anthropic provider", () => {
		expect(claudeModelArgs({ provider: "openrouter", model: "moonshotai/kimi-k3" })).toEqual([]);
	});

	test("returns nothing without frontmatter", () => {
		expect(claudeModelArgs(undefined)).toEqual([]);
	});
});

describe("claudeCodeAdapter.ignoredModelSelection", () => {
	test("names a non-Anthropic provider and model the CLI will not use", () => {
		const ignored = claudeCodeAdapter.ignoredModelSelection?.({
			provider: "openrouter",
			model: "moonshotai/kimi-k3",
		});
		expect(ignored?.provider).toBe("openrouter");
		expect(ignored?.model).toBe("moonshotai/kimi-k3");
		expect(ignored?.reason).toContain("Anthropic");
	});

	test("names a non-Anthropic provider that came without a model", () => {
		const ignored = claudeCodeAdapter.ignoredModelSelection?.({ provider: " openrouter " });
		expect(ignored?.provider).toBe("openrouter");
		expect(ignored !== undefined && "model" in ignored).toBe(false);
	});

	test("treats a blank provider as no provider", () => {
		expect(
			claudeCodeAdapter.ignoredModelSelection?.({ provider: "   ", model: "opus" }),
		).toBeUndefined();
	});

	test("reports nothing for an Anthropic model it passes through", () => {
		expect(
			claudeCodeAdapter.ignoredModelSelection?.({
				provider: "anthropic",
				model: "claude-opus-5-5",
			}),
		).toBeUndefined();
		expect(claudeCodeAdapter.ignoredModelSelection?.({ model: "opus" })).toBeUndefined();
		expect(claudeCodeAdapter.ignoredModelSelection?.(undefined)).toBeUndefined();
	});
});

describe("claudeCodeBurrowTmpdir", () => {
	test("linux resolves under bwrap's /workspace remap, not the host path", () => {
		expect(claudeCodeBurrowTmpdir("/host/ws", "linux")).toBe(
			`/workspace/${CLAUDE_CODE_SANDBOX_TMPDIR}`,
		);
	});

	test("darwin keeps the host workspace path (sandbox-exec doesn't remap)", () => {
		expect(claudeCodeBurrowTmpdir("/Users/u/ws", "darwin")).toBe(
			`/Users/u/ws/${CLAUDE_CODE_SANDBOX_TMPDIR}`,
		);
	});
});

describe("claudeCodeAdapter.encodeInboxMessage", () => {
	test("emits one user message with a priority-tagged text block per message", () => {
		const out = claudeCodeAdapter.encodeInboxMessage?.([
			fakeMessage({ body: "first", priority: "urgent" }),
			fakeMessage({ body: "second", priority: "low" }),
		]);
		expect(out?.stdin).toBe(
			`${JSON.stringify({
				type: "user",
				message: {
					role: "user",
					content: [
						{ type: "text", text: "[STEERING] (priority: urgent) first" },
						{ type: "text", text: "[STEERING] (priority: low) second" },
					],
				},
			})}\n`,
		);
	});
});

describe("claudeCodeAdapter.parseEvents", () => {
	test("delegates to parseJsonlClaude — system envelope becomes state_change/system", () => {
		const events =
			claudeCodeAdapter.parseEvents?.(
				JSON.stringify({ type: "system", subtype: "init", session_id: "abc" }),
			) ?? [];
		expect(events).toHaveLength(1);
		expect(events[0]?.kind).toBe("state_change");
		expect(events[0]?.stream).toBe("system");
	});
});

describe("claudeCodeAdapter stdin-hold surface", () => {
	const closes = (line: Record<string, unknown>): boolean[] =>
		parseJsonlClaude(JSON.stringify(line)).map(
			(ev) => claudeCodeAdapter.shouldCloseStdinOnEvent?.(ev) ?? false,
		);

	test("closes stdin on every result line, an error result included", () => {
		// With stdin held, the CLI waits for another turn after `result`.
		expect(closes({ type: "result", subtype: "success", is_error: false })).toEqual([true]);
		expect(closes({ type: "result", subtype: "error_during_execution", is_error: true })).toEqual([
			true,
		]);
	});

	test("keeps stdin open on init, assistant, and tool result lines", () => {
		expect(closes({ type: "system", subtype: "init" })).toEqual([false]);
		expect(
			closes({
				type: "assistant",
				message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }] },
			}),
		).toEqual([false]);
		expect(
			closes({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1" }] } }),
		).toEqual([false]);
	});

	test("encodes a mid-run steer as one newline-terminated user message", () => {
		expect(
			claudeCodeAdapter.encodeSteeringMessage?.(fakeMessage({ body: "wrap up", priority: "high" })),
		).toEqual({
			stdin: `${JSON.stringify({
				type: "user",
				message: {
					role: "user",
					content: [{ type: "text", text: "[STEERING] (priority: high) wrap up" }],
				},
			})}\n`,
		});
	});
});

describe("claudeCodeAdapter.prepareWorkspace", () => {
	let dir: string;
	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "warren-claude-prep-"));
	});
	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	test("writes a default .claude/settings.local.json", async () => {
		await claudeCodeAdapter.prepareWorkspace?.({ runId: "run_test", workspacePath: dir });
		const body = await readFile(join(dir, CLAUDE_CODE_SETTINGS_PATH), "utf8");
		const parsed = JSON.parse(body);
		expect(parsed).toMatchObject({ permissions: {}, hooks: {} });
	});

	test('installs mulch\'s SessionStart + PreToolUse hooks under the mulch "on" arm', async () => {
		await claudeCodeAdapter.prepareWorkspace?.({
			runId: "run_test",
			workspacePath: dir,
			frontmatter: { mulch: "on" },
		});
		const parsed = JSON.parse(await readFile(join(dir, CLAUDE_CODE_SETTINGS_PATH), "utf8"));
		expect(parsed.hooks.SessionStart[0].hooks[0].command).toBe("ml prime");
		expect(parsed.hooks.PreToolUse[0]).toEqual({
			matcher: "Read|Edit|Write|MultiEdit|NotebookEdit|Bash",
			hooks: [{ type: "command", command: "ml hook" }],
		});
	});

	test('keeps hooks empty under the mulch "off" arm', async () => {
		await claudeCodeAdapter.prepareWorkspace?.({
			runId: "run_test",
			workspacePath: dir,
			frontmatter: { mulch: "off" },
		});
		const parsed = JSON.parse(await readFile(join(dir, CLAUDE_CODE_SETTINGS_PATH), "utf8"));
		expect(parsed.hooks).toEqual({});
	});

	test("plants .sandbox-tmp/ + a `*` .gitignore (burrow-8452)", async () => {
		await claudeCodeAdapter.prepareWorkspace?.({ runId: "run_test", workspacePath: dir });
		const fs = await import("node:fs");
		const tmpDir = join(dir, CLAUDE_CODE_SANDBOX_TMPDIR);
		expect(fs.statSync(tmpDir).isDirectory()).toBe(true);
		expect(await readFile(join(tmpDir, ".gitignore"), "utf8")).toBe("*\n");
	});

	test("never writes credentials into the workspace (the git checkout the run pushes)", async () => {
		await claudeCodeAdapter.prepareWorkspace?.({ runId: "run_test", workspacePath: dir });
		const fs = await import("node:fs");
		expect(fs.existsSync(join(dir, ".claude", ".credentials.json"))).toBe(false);
	});
});

describe("claudeCodeAdapter credential and connector isolation", () => {
	test("excludes the credentials file from run commits, by exact path", () => {
		expect(claudeCodeAdapter.commitExcludes).toEqual([".claude/.credentials.json"]);
	});

	test("turns off the account's claude.ai connectors in the spawn env", () => {
		const cmd = claudeCodeAdapter.buildSpawnCommand?.(fakeSpawnContext());
		expect(cmd?.env?.ENABLE_CLAUDEAI_MCP_SERVERS).toBe("false");
	});
});

describe("claudeCodeAdapter one-shot session", () => {
	test("turns off background tasks, whose completion notice a --print run never receives", () => {
		const cmd = claudeCodeAdapter.buildSpawnCommand?.(fakeSpawnContext());
		expect(cmd?.env?.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS).toBe("1");
	});

	test("raises the foreground Bash timeout ceiling to one hour so a full gate fits", () => {
		const cmd = claudeCodeAdapter.buildSpawnCommand?.(fakeSpawnContext());
		expect(cmd?.env?.BASH_MAX_TIMEOUT_MS).toBe("3600000");
	});
});

describe("forwardClaudeHostCredentials (linux)", () => {
	let workspaceDir: string;
	let fakeHome: string;
	beforeEach(async () => {
		workspaceDir = await mkdtemp(join(tmpdir(), "warren-claude-prep-"));
		fakeHome = await mkdtemp(join(tmpdir(), "warren-claude-home-"));
	});
	afterEach(async () => {
		await rm(workspaceDir, { recursive: true, force: true });
		await rm(fakeHome, { recursive: true, force: true });
	});

	test("copies host ~/.claude/.credentials.json into the run's .claude/ when present", async () => {
		const fs = await import("node:fs/promises");
		await fs.mkdir(join(fakeHome, ".claude"), { recursive: true });
		await writeFile(join(fakeHome, ".claude", ".credentials.json"), '{"token":"fake"}');

		await forwardClaudeHostCredentials(workspaceDir, { home: fakeHome, plat: "linux" });

		const forwarded = await readFile(join(workspaceDir, ".claude", ".credentials.json"), "utf8");
		expect(JSON.parse(forwarded)).toEqual({ token: "fake" });
	});

	test("is a no-op when the host has no ~/.claude/.credentials.json", async () => {
		await forwardClaudeHostCredentials(workspaceDir, { home: fakeHome, plat: "linux" });
		const fs = await import("node:fs");
		expect(fs.existsSync(join(workspaceDir, ".claude", ".credentials.json"))).toBe(false);
	});
});

describe("forwardClaudeHostCredentials (darwin)", () => {
	let workspaceDir: string;
	beforeEach(async () => {
		workspaceDir = await mkdtemp(join(tmpdir(), "warren-claude-prep-"));
	});
	afterEach(async () => {
		await rm(workspaceDir, { recursive: true, force: true });
	});

	test("extracts the Keychain blob and writes it as .credentials.json", async () => {
		const blob = '{"claudeAiOauth":{"accessToken":"oat-x","refreshToken":"rt-y"}}';
		await forwardClaudeHostCredentials(workspaceDir, {
			plat: "darwin",
			keychainReader: async (service) => {
				expect(service).toBe("Claude Code-credentials");
				return blob;
			},
		});
		const written = await readFile(join(workspaceDir, ".claude", ".credentials.json"), "utf8");
		expect(written).toBe(blob);
	});

	test("is a no-op when Keychain has no entry", async () => {
		await forwardClaudeHostCredentials(workspaceDir, {
			plat: "darwin",
			keychainReader: async () => null,
		});
		const fs = await import("node:fs");
		expect(fs.existsSync(join(workspaceDir, ".claude", ".credentials.json"))).toBe(false);
	});
});

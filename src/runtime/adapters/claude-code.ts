/**
 * The `claude-code` adapter (warren-c80e phase 1; harness hooks
 * source-lifted from burrow's `src/runtime/claude-code.ts` in
 * warren-7933, plan pl-3007).
 *
 * Claude Code's `--input-format stream-json` reads one user/system JSON
 * envelope per line from stdin and emits matching `--output-format
 * stream-json` lines on stdout. The adapter renders the prompt + any
 * pending steering messages as a single multi-line stdin blob, then the
 * parser in `./parsers/jsonl-claude.ts` turns each output line into
 * structured events.
 *
 * `prepareWorkspace` writes a minimal `.claude/settings.local.json` so
 * the agent has a stable settings file even when the project ships none,
 * plants a private `.sandbox-tmp/` for the spawn's `TMPDIR` (burrow-8452 —
 * the host UID-keyed `/tmp/claude-${uid}/` root races every other
 * claude-code on the machine during startup cleanup). It never writes
 * credentials into the workspace: the workspace is the git checkout the run
 * pushes, so a broad `git add -A` would publish them. Host credentials, when
 * forwarded at all, go to the run's private $HOME (`../local/drive-prepare.ts`).
 *
 * claude-code `--print` relies on stdin EOF to flush its final output, so
 * this adapter deliberately declares NO `shouldCloseStdinOnEvent` and NO
 * `encodeSteeringMessage` — pending messages flow through
 * `pendingMessages` at the next spawn (burrow SPEC §13.2).
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mulchClaudeHooks, readMulchArm } from "./mulch-arm.ts";
import { parseJsonlClaude } from "./parsers/jsonl-claude.ts";
import type {
	AdapterPrepareContext,
	AdapterRuntimeEvent,
	AdapterSpawnContext,
	AgentFrontmatter,
	AgentRuntimeAdapter,
	IgnoredModelSelection,
	SpawnCommand,
	SteeringMessage,
} from "./types.ts";

const CLAUDE_BIN = "claude";

/** Ceiling for one foreground Bash call in a run: one hour. */
const FOREGROUND_BASH_MAX_TIMEOUT_MS = 60 * 60 * 1000;

/**
 * `--model <id>` from the resolved frontmatter, or nothing.
 *
 * The run row freezes the declared model (agent frontmatter, then the project
 * default, then the per-run override), and analytics group by it. Without this
 * flag the CLI fell back to the logged-in account's default model, so a run the
 * UI labelled `claude-sonnet-4-6` actually ran on whatever the account default
 * was. Claude Code speaks only the Anthropic API, so a non-Anthropic provider
 * (a pi-only model id such as an OpenRouter slug) leaves the flag off rather
 * than handing the CLI a model it cannot resolve.
 */
export function claudeModelArgs(frontmatter: AgentFrontmatter | undefined): string[] {
	const model = frontmatter?.model?.trim();
	if (model === undefined || model === "") return [];
	if (claudeIgnoredModelSelection(frontmatter) !== undefined) return [];
	return ["--model", model];
}

/**
 * The selection {@link claudeModelArgs} leaves off, named for dispatch's
 * warning event (namphuongtran/warren#7). Any non-Anthropic provider is dropped, model or
 * not: the CLI talks to Anthropic regardless, on the account's default
 * model when no `--model` rides the argv.
 */
export function claudeIgnoredModelSelection(
	frontmatter: AgentFrontmatter | undefined,
): IgnoredModelSelection | undefined {
	const provider = frontmatter?.provider?.trim();
	if (provider === undefined || provider === "" || provider === "anthropic") return undefined;
	const model = frontmatter?.model?.trim();
	return {
		provider,
		...(model !== undefined && model !== "" ? { model } : {}),
		reason:
			"Claude Code speaks only the Anthropic API, so it cannot use this provider; " +
			"the run uses the logged-in account's default model instead",
	};
}

export const CLAUDE_CODE_SETTINGS_PATH = ".claude/settings.local.json";

/**
 * Per-run TMPDIR root. claude-code's Bash tool stores command output
 * under `${TMPDIR-/tmp}/claude-${uid}/...` and runs a startup cleanup
 * sweep across the entire UID-keyed root — that races every other
 * claude-code on the host (the user's terminal session, sibling runs) and
 * surfaces as `<bash output unavailable: ... could not be read (EPERM)>`.
 * Pinning TMPDIR inside the workspace gives each spawned claude a private
 * sweep boundary (burrow-8452).
 */
export const CLAUDE_CODE_SANDBOX_TMPDIR = ".sandbox-tmp";

const DEFAULT_SETTINGS: Record<string, unknown> = {
	permissions: {},
	hooks: {},
};

export const claudeCodeAdapter: AgentRuntimeAdapter = {
	runtimeId: "claude-code",
	/**
	 * The harness drops `.claude/settings.local.json` into the workspace at
	 * runtime. This is the prefix `HARNESS_STATE_PREFIXES` carried before the
	 * seam existed, moved verbatim (warren-f6f2). `.claude.json` is a sibling
	 * file (not a child of `.claude/`) that claude-code also writes at runtime —
	 * `'.claude.json'.startsWith('.claude/')` is false, so it needs its own
	 * entry (warren-8dc8).
	 */
	harnessStatePrefixes: [".claude/", ".claude.json"],
	/**
	 * Exact files only, never the `.claude/` prefix: `.claude/` is tracked in
	 * plenty of target repos (this one keeps five files there), so excluding
	 * the prefix would eat real work. `.claude/settings.local.json` and
	 * `.claude.json` have not been observed in a pull request yet; add the
	 * exact file the day one does (warren-194a). `.claude/.credentials.json`
	 * is the exception that cannot wait for an observation: it holds an OAuth
	 * session, and one broad commit would push it to the remote. Nothing in
	 * warren writes it into the workspace any more, so this is the backstop
	 * for a harness or a target repo that does.
	 */
	commitExcludes: [".claude/.credentials.json"],
	/**
	 * Empty by evidence, not by omission. The provider-error net (warren-edc3)
	 * was written against pi's turn lifecycle, and warren has never observed
	 * a claude-code envelope carrying `stopReason`. The generic classifier
	 * still reads the union of every adapter's types, so this declaration
	 * does not narrow what a claude-code run is checked against today; see
	 * `providerErrorEnvelopeTypes` in `./index.ts`.
	 */
	terminalErrorEnvelopeTypes: [],

	buildSpawnCommand(ctx: AdapterSpawnContext): SpawnCommand {
		return {
			argv: [
				CLAUDE_BIN,
				"--print",
				"--input-format",
				"stream-json",
				"--output-format",
				"stream-json",
				"--verbose",
				// The sandbox is the enforcement boundary; an in-app prompt would
				// deadlock a non-interactive spawn.
				"--dangerously-skip-permissions",
				...claudeModelArgs(ctx.frontmatter),
			],
			env: {
				TMPDIR: claudeCodeBurrowTmpdir(ctx.workspacePath),
				// A subscription login makes the CLI fetch the account's claude.ai
				// connectors (mail, drive, docs, ...) into a run that executes with
				// --dangerously-skip-permissions. A coding run needs none of them.
				// This is the documented switch ("Disable claude.ai connectors",
				// code.claude.com/docs/en/mcp); --strict-mcp-config does not cover them.
				ENABLE_CLAUDEAI_MCP_SERVERS: "false",
				// A --print session ends with the agent's turn. A Bash command the
				// agent started with run_in_background then never reports back: the
				// agent ends its turn to "wait for the notification", the session
				// exits, and reap finds uncommitted edits (`dropped_commit`). Seen on
				// a familyroots run whose final gate went to the background.
				CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1",
				// With background tasks off, a full quality gate has to fit one
				// foreground Bash call. The CLI caps that call at 10 minutes by
				// default; the run's own duration limit still bounds the session.
				BASH_MAX_TIMEOUT_MS: String(FOREGROUND_BASH_MAX_TIMEOUT_MS),
			},
			stdin: encodeClaudeStdin(ctx.prompt, ctx.pendingMessages),
		};
	},

	parseEvents(line: string): AdapterRuntimeEvent[] {
		return parseJsonlClaude(line);
	},

	ignoredModelSelection: claudeIgnoredModelSelection,

	encodeInboxMessage(messages: readonly SteeringMessage[]): { stdin: string } {
		return { stdin: messages.map(claudeUserTurnFromMessage).join("\n") };
	},

	async prepareWorkspace(ctx: AdapterPrepareContext): Promise<void> {
		const claudeDir = join(ctx.workspacePath, ".claude");
		mkdirSync(claudeDir, { recursive: true });
		// Mulch arm "on" installs mulch's hooks (`./mulch-arm.ts`); absent/"off" keeps `hooks: {}`.
		const settings =
			readMulchArm(ctx.frontmatter) === "on"
				? { ...DEFAULT_SETTINGS, hooks: mulchClaudeHooks() }
				: DEFAULT_SETTINGS;
		writeFileSync(
			join(ctx.workspacePath, CLAUDE_CODE_SETTINGS_PATH),
			`${JSON.stringify(settings, null, 2)}\n`,
			{ encoding: "utf8", flag: "w" },
		);
		ensureBurrowTmpdir(ctx.workspacePath);
	},
};

/**
 * Resolve the in-sandbox absolute path of the per-run TMPDIR. The runtime
 * always shares a platform with the host that runs it, so
 * `process.platform` is the right proxy for sandbox layout: bwrap remaps
 * the workspace to `/workspace`, sandbox-exec leaves it at the host path.
 * Exposed with a `plat` override for unit tests.
 */
export function claudeCodeBurrowTmpdir(
	workspacePath: string,
	plat: NodeJS.Platform = process.platform,
): string {
	const home = plat === "linux" ? "/workspace" : workspacePath;
	return join(home, CLAUDE_CODE_SANDBOX_TMPDIR);
}

/**
 * Materialize the per-run TMPDIR on the host and drop a `*` .gitignore so
 * tool output never trips `git status` inside a project worktree.
 */
function ensureBurrowTmpdir(workspacePath: string): void {
	const dir = join(workspacePath, CLAUDE_CODE_SANDBOX_TMPDIR);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, ".gitignore"), "*\n", { encoding: "utf8", flag: "w" });
}

/**
 * Encode the run's prompt followed by any pending steering messages as a
 * single stdin blob (one JSON envelope per line). Exported for unit tests.
 */
export function encodeClaudeStdin(prompt: string, messages: readonly SteeringMessage[]): string {
	const lines: string[] = [];
	if (prompt.length > 0) lines.push(claudeUserTurn(prompt));
	for (const m of messages) lines.push(claudeUserTurnFromMessage(m));
	return lines.join("\n");
}

function claudeUserTurn(text: string): string {
	return JSON.stringify({
		type: "user",
		message: { role: "user", content: [{ type: "text", text }] },
	});
}

function claudeUserTurnFromMessage(message: SteeringMessage): string {
	const tag = `[STEERING] (priority: ${message.priority}) `;
	return claudeUserTurn(`${tag}${message.body}`);
}

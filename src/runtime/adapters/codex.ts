/**
 * The `codex` adapter: OpenAI's Codex CLI as a warren harness (namphuongtran/warren#17).
 *
 * Spawn: `codex exec --json … -` runs one headless turn. The prompt, with any
 * pending steering folded after it, arrives on stdin, and one JSONL
 * `ThreadEvent` per line comes back on stdout, parsed by
 * `./parsers/jsonl-codex.ts`. `codex exec` reads stdin once and has no input
 * channel during the turn, so the adapter declares no
 * `shouldCloseStdinOnEvent` and no `encodeSteeringMessage`: steering is
 * spawn-only.
 *
 * Sandbox: warren's sandbox (bwrap, sandbox-exec, the Docker container, or the
 * K8s pod) is the security boundary. Codex's own sandbox (Landlock + seccomp
 * on Linux, Seatbelt on macOS) cannot nest inside it, so the argv passes
 * `--dangerously-bypass-approvals-and-sandbox`, which Codex documents as
 * "intended solely for running in environments that are externally
 * sandboxed". Every provider spawns this argv inside warren's sandbox; there is
 * no path that runs it on the bare host. `--skip-git-repo-check` keeps Codex
 * from refusing the per-run private git dir layout (warren-3c1e).
 *
 * Auth: `codex exec` reads `CODEX_API_KEY`. Operators already hold
 * `OPENAI_API_KEY` in warren's provider registry, so a `sh -c` shim lends it
 * to `CODEX_API_KEY` when the latter is unset. The value moves env to env and
 * never touches the argv. Without a key, `./codex-credentials.ts` copies the
 * host's ChatGPT login into the run's private home.
 *
 * Design record: docs/design/runtime-codex-adapter.md.
 */

import { forwardCodexHostCredentials } from "./codex-credentials.ts";
import { parseJsonlCodex } from "./parsers/jsonl-codex.ts";
import type {
	AdapterParseContext,
	AdapterRuntimeEvent,
	AdapterSpawnContext,
	AgentFrontmatter,
	AgentRuntimeAdapter,
	IgnoredModelSelection,
	SpawnCommand,
	SteeringMessage,
} from "./types.ts";

const CODEX_BIN = "codex";

/**
 * Lend `OPENAI_API_KEY` to `CODEX_API_KEY` when only the former is set, then
 * hand the argv to the real CLI. `$0` is a label; `"$@"` is the codex argv.
 */
const CODEX_AUTH_SHIM =
	'if [ -z "$CODEX_API_KEY" ] && [ -n "$OPENAI_API_KEY" ]; then ' +
	'export CODEX_API_KEY="$OPENAI_API_KEY"; fi; exec codex "$@"';

/** Host-env names the sandbox forwards for a Codex run. */
const CODEX_ENV_PASSTHROUGH: readonly string[] = [
	"OPENAI_API_KEY",
	"OPENAI_BASE_URL",
	"CODEX_API_KEY",
];

/** The selection Codex cannot honor: any provider other than OpenAI. */
export function codexIgnoredModelSelection(
	frontmatter: AgentFrontmatter | undefined,
): IgnoredModelSelection | undefined {
	const provider = frontmatter?.provider?.trim();
	if (provider === undefined || provider === "" || provider.toLowerCase() === "openai") {
		return undefined;
	}
	const model = frontmatter?.model?.trim();
	return {
		provider,
		...(model !== undefined && model !== "" ? { model } : {}),
		reason:
			"the Codex CLI speaks only the OpenAI API, so it cannot use this provider; " +
			"the run uses Codex's default model instead",
	};
}

/** The model Codex will run, or `undefined` when the CLI picks its own. */
function codexModel(frontmatter: AgentFrontmatter | undefined): string | undefined {
	const model = frontmatter?.model?.trim();
	if (model === undefined || model === "") return undefined;
	return codexIgnoredModelSelection(frontmatter) === undefined ? model : undefined;
}

function steeringLine(message: SteeringMessage): string {
	return `[STEERING] (priority: ${message.priority}) ${message.body}`;
}

/** The prompt followed by pending steering, one blank line apart. */
export function encodeCodexPrompt(prompt: string, messages: readonly SteeringMessage[]): string {
	return [prompt, ...messages.map(steeringLine)].filter((part) => part.length > 0).join("\n\n");
}

export const codexAdapter: AgentRuntimeAdapter = {
	runtimeId: "codex",
	/**
	 * Empty by construction: Codex keeps sessions, logs, and auth under
	 * `$CODEX_HOME` (the run's private `$HOME/.codex`), never in the workspace.
	 */
	harnessStatePrefixes: [],
	commitExcludes: [],
	/**
	 * `turn.failed` is normalized onto the shared `result` envelope with
	 * `stopReason: "error"`, and a successful turn carries `stopReason:
	 * "end_turn"`, which clears an earlier error. claude-code's own `result`
	 * carries no `stopReason`, so the classifier ignores it as before.
	 */
	terminalErrorEnvelopeTypes: ["result"],
	// Codex writes files only through `apply_patch` items (namphuongtran/warren#36).
	fileEditToolNames: ["apply_patch"],
	// Empty by evidence: `codex exec --json` emits no periodic progress event
	// while a command runs that warren has observed (namphuongtran/warren#83).
	keepAliveEnvelopeTypes: [],
	cliBinaries: [CODEX_BIN],

	envPassthrough(): readonly string[] {
		return CODEX_ENV_PASSTHROUGH;
	},

	buildSpawnCommand(ctx: AdapterSpawnContext): SpawnCommand {
		const model = codexModel(ctx.frontmatter);
		return {
			argv: [
				"sh",
				"-c",
				CODEX_AUTH_SHIM,
				CODEX_BIN,
				"exec",
				"--json",
				"--skip-git-repo-check",
				"--dangerously-bypass-approvals-and-sandbox",
				...(model !== undefined ? ["--model", model] : []),
				"-",
			],
			stdin: encodeCodexPrompt(ctx.prompt, ctx.pendingMessages),
		};
	},

	parseEvents(line: string, ctx?: AdapterParseContext): AdapterRuntimeEvent[] {
		const model = codexModel(ctx?.frontmatter);
		const provider = ctx?.frontmatter?.provider?.trim();
		return parseJsonlCodex(line, {
			...(model !== undefined ? { model } : {}),
			...(provider !== undefined && provider !== "" ? { provider } : {}),
		});
	},

	encodeInboxMessage(messages: readonly SteeringMessage[]): { stdin: string } {
		return { stdin: messages.map(steeringLine).join("\n\n") };
	},

	ignoredModelSelection: codexIgnoredModelSelection,

	forwardHostCredentials: (ctx) => forwardCodexHostCredentials(ctx),
};

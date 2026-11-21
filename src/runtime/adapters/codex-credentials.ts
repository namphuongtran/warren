/**
 * Codex host-credential hand-off (namphuongtran/warren#17), the Codex counterpart of
 * `./claude-credentials.ts`.
 *
 * Codex authenticates one of two ways:
 *
 *   - An API key in the env (`CODEX_API_KEY`, or `OPENAI_API_KEY`, which the
 *     adapter's spawn shim lends to `CODEX_API_KEY`). The sandbox allowlist
 *     forwards these by name, so nothing is written anywhere.
 *   - A ChatGPT login stored in `$CODEX_HOME/auth.json` (default
 *     `~/.codex/auth.json`). When no key is in the env, this module copies that
 *     file into the run's private `$HOME/.codex/auth.json`, where the sandboxed
 *     CLI finds it through its default `CODEX_HOME`.
 *
 * The host is read, never written: no `config.toml`, no trust entries, no
 * hooks. The copy lands in the run's private home, never in the workspace the
 * run pushes. K8s pods get no copy; they authenticate with the API key secret.
 */

import { existsSync, mkdirSync } from "node:fs";
import { chmod, copyFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AdapterCredentialContext } from "./types.ts";

/** Env names that authenticate Codex on their own. */
export const CODEX_AUTH_ENV: readonly string[] = ["CODEX_API_KEY", "OPENAI_API_KEY"];

const CODEX_AUTH_FILE = "auth.json";

export interface ForwardCodexCredentialsOptions {
	/** Host `CODEX_HOME`. Defaults to `$CODEX_HOME`, then `~/.codex`. */
	readonly hostCodexHome?: string;
}

function defaultHostCodexHome(): string {
	const fromEnv = process.env.CODEX_HOME?.trim();
	return fromEnv !== undefined && fromEnv !== "" ? fromEnv : join(homedir(), ".codex");
}

/**
 * Copy the host's Codex login into the run's `$HOME/.codex/` with mode 0600,
 * unless the env already carries an API key. A host with no login is a no-op.
 */
export async function forwardCodexHostCredentials(
	ctx: AdapterCredentialContext,
	options: ForwardCodexCredentialsOptions = {},
): Promise<void> {
	if (CODEX_AUTH_ENV.some((name) => ctx.hasEnv(name))) return;
	const source = join(options.hostCodexHome ?? defaultHostCodexHome(), CODEX_AUTH_FILE);
	if (!existsSync(source)) return;
	const runCodexHome = join(ctx.homePath, ".codex");
	mkdirSync(runCodexHome, { recursive: true, mode: 0o700 });
	const target = join(runCodexHome, CODEX_AUTH_FILE);
	await copyFile(source, target);
	await chmod(target, 0o600);
}

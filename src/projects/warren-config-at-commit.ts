/**
 * Load the `.warren/` config a dispatch runs under (namphuongtran/warren#165).
 * The host clone's checkout follows the last refresh, so it is never the
 * source. The config is built from two sources:
 *
 * - Every file the given commit (the default-branch tip the refresh just
 *   fetched) carries under `.warren/`, read straight out of the object
 *   database with `git ls-tree` and `git cat-file`.
 * - Every file under `.warren/` that the host clone holds untracked and the
 *   commit does not carry. That is operator-local config: `warren init`
 *   writes it into the clone of a mirror whose upstream will never carry it
 *   (warren-540f). No commit holds it, so no checkout can make it stale.
 *
 * HEAD, the index, and the working tree stay untouched. Both sources go
 * through the same `loadWarrenConfig` parser on its injected I/O seam, so
 * missing, malformed, and deprecated files report exactly as they do from
 * disk. Nothing here writes to the `WarrenConfigCache`: that cache is the
 * working-tree view the UI, doctor, and triggers read.
 */

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
	type LoadedWarrenConfig,
	loadWarrenConfig,
	WARREN_CONFIG_DIR,
} from "../warren-config/index.ts";
import type { SpawnFn } from "./clone.ts";
import type { ProjectsConfig } from "./config.ts";
import { DEFAULT_GIT_TIMEOUT_MS, runGit } from "./refresh.ts";

export interface LoadWarrenConfigAtCommitInput {
	readonly config: ProjectsConfig;
	/** The project clone root; the commit must already be in its object database. */
	readonly localPath: string;
	readonly commit: string;
	readonly spawn: SpawnFn;
	readonly timeoutMs?: number;
}

/** Tree modes git uses for a regular file; a symlink (120000) is not followed. */
const REGULAR_FILE_MODES: ReadonlySet<string> = new Set(["100644", "100755"]);

export async function loadWarrenConfigAtCommit(
	input: LoadWarrenConfigAtCommitInput,
): Promise<LoadedWarrenConfig> {
	const { config, localPath, commit, spawn } = input;
	const timeoutMs = input.timeoutMs ?? config.gitTimeoutMs ?? DEFAULT_GIT_TIMEOUT_MS;
	const git = (args: readonly string[]) =>
		runGit(spawn, [config.gitBinary, ...args], { cwd: localPath, timeoutMs });

	const tree = await git(["ls-tree", "-r", "-z", "--full-tree", commit, "--", WARREN_CONFIG_DIR]);
	const blobs = parseBlobListing(tree.stdout, localPath);
	// No --exclude-standard: an operator-local file counts even when ignored.
	const untracked = await git(["ls-files", "-z", "--others", "--", WARREN_CONFIG_DIR]);
	const local = new Set(
		splitNul(untracked.stdout)
			.map((path) => join(localPath, path))
			.filter((path) => !blobs.has(path)),
	);
	const present = withAncestors([...blobs.keys(), ...local], localPath);

	return loadWarrenConfig({
		projectPath: localPath,
		exists: (path) => present.has(path),
		readFile: async (path) => {
			if (local.has(path)) return readFile(path, "utf8");
			const oid = blobs.get(path);
			if (oid === undefined || oid === null) {
				throw new Error(`not a regular file at ${commit}`);
			}
			return (await git(["cat-file", "blob", oid])).stdout;
		},
	});
}

/**
 * Map each blob under `.warren/` to its object id, keyed by the absolute
 * path the loader asks for. A blob that is not a regular file maps to
 * `null`: it exists, but reading it fails, so the loader reports it.
 */
function parseBlobListing(stdout: string, localPath: string): Map<string, string | null> {
	const blobs = new Map<string, string | null>();
	for (const entry of splitNul(stdout)) {
		const tab = entry.indexOf("\t");
		if (tab < 0) continue;
		const [mode, type, oid] = entry.slice(0, tab).split(" ");
		if (type !== "blob" || mode === undefined || oid === undefined) continue;
		blobs.set(join(localPath, entry.slice(tab + 1)), REGULAR_FILE_MODES.has(mode) ? oid : null);
	}
	return blobs;
}

/** Every file plus each directory between it and `root`, and `root` itself. */
function withAncestors(files: readonly string[], root: string): Set<string> {
	const present = new Set<string>([root]);
	for (const file of files) {
		for (let path = file; path.startsWith(`${root}/`); path = dirname(path)) {
			present.add(path);
		}
	}
	return present;
}

function splitNul(stdout: string): string[] {
	return stdout.split("\0").filter((entry) => entry !== "");
}

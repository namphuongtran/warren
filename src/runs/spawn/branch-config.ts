/**
 * Branch-sourced config keys for a run cut from a non-default base
 * (namphuongtran/warren#169).
 *
 * Dispatch reads `.warren/` from the host clone, and the dispatch refresh
 * always leaves that clone on the default-branch tip. The tip supplies every
 * guardrail and `repoContext`, so a branch cannot loosen its own limits and an
 * old branch still sees config merged after it was cut.
 *
 * A run cut from another base (a `--ref` / existing-branch repair, a
 * continuation) takes the keys in `BRANCH_SOURCED_KEYS` from the base's
 * committed config when the base sets them. Those keys describe how to build
 * and check the branch's own code. They run only inside the sandbox, where the
 * branch's code runs anyway, so the branch gains no new power. A key the base
 * does not set keeps the default branch's value.
 *
 * The base's config is read from git objects at the base commit. A base with
 * no committed config (a mirror, whose config is untracked, warren-540f)
 * gives no overlay. A malformed one gives no overlay and a warning: the run
 * keeps the default branch's values, and a repair run can still fix the file.
 */

import { join } from "node:path";
import { DEFAULT_GIT_TIMEOUT_MS, type SpawnFn } from "../../projects/clone.ts";
import type { RefreshProjectResult } from "../../projects/manage.ts";
import { WARREN_CONFIG_DIR, warrenConfigRelativePath } from "../../warren-config/config.ts";
import type { WarrenConfigFileError } from "../../warren-config/errors.ts";
import { loadWarrenConfig } from "../../warren-config/load.ts";
import type { DefaultsConfig } from "../../warren-config/schema.ts";
import type { SpawnRunInput } from "./types.ts";

/** The keys a branch run takes from its base, in the dotted form logs name them. */
export const BRANCH_SOURCED_KEYS = ["qualityGate", "migrations.regenerateCommand"] as const;
export type BranchSourcedKey = (typeof BRANCH_SOURCED_KEYS)[number];

/** The guardrail-bearing files, in the loader's precedence order. */
const DEFAULTS_FILES = [warrenConfigRelativePath("config"), warrenConfigRelativePath("defaults")];

export interface ReadBranchDefaultsInput {
	readonly spawn: SpawnFn;
	readonly gitBinary: string;
	/** Host clone path; git runs there and the loader resolves paths under it. */
	readonly projectPath: string;
	/** The base commit whose committed `.warren/` is read. */
	readonly baseSha: string;
}

export interface BranchDefaults {
	/** `null` when the base commits no defaults file or the file is malformed. */
	readonly defaults: DefaultsConfig | null;
	readonly errors: readonly WarrenConfigFileError[];
}

/**
 * Load the base commit's defaults through the same loader the working tree
 * uses, with I/O served from git objects (`git cat-file blob <sha>:<path>`).
 */
export async function readBranchDefaults(input: ReadBranchDefaultsInput): Promise<BranchDefaults> {
	const files = new Map<string, string>();
	for (const relPath of DEFAULTS_FILES) {
		const blob = await input.spawn(
			[input.gitBinary, "cat-file", "blob", `${input.baseSha}:${relPath}`],
			{ cwd: input.projectPath, timeoutMs: DEFAULT_GIT_TIMEOUT_MS },
		);
		if (blob.exitCode === 0) files.set(join(input.projectPath, relPath), blob.stdout);
	}
	if (files.size === 0) return { defaults: null, errors: [] };
	const dirPath = join(input.projectPath, WARREN_CONFIG_DIR);
	const loaded = await loadWarrenConfig({
		projectPath: input.projectPath,
		exists: (path) => path === input.projectPath || path === dirPath || files.has(path),
		readFile: async (path) => {
			const contents = files.get(path);
			if (contents === undefined) throw new Error(`not in ${input.baseSha}: ${path}`);
			return contents;
		},
	});
	return { defaults: loaded.defaults, errors: loaded.errors };
}

export interface BranchOverlay {
	readonly defaults: DefaultsConfig | null;
	/** The keys the base set, so its value replaced the default branch's. */
	readonly taken: readonly BranchSourcedKey[];
}

/** Lay the base's branch-sourced keys over the default branch's defaults. */
export function applyBranchDefaults(
	main: DefaultsConfig | null,
	branch: DefaultsConfig | null,
): BranchOverlay {
	if (branch === null) return { defaults: main, taken: [] };
	let defaults = main;
	const taken: BranchSourcedKey[] = [];
	if (branch.qualityGate !== undefined) {
		defaults = { ...defaults, qualityGate: branch.qualityGate };
		taken.push("qualityGate");
	}
	const regenerateCommand = branch.migrations?.regenerateCommand;
	if (regenerateCommand !== undefined) {
		defaults = { ...defaults, migrations: { ...defaults?.migrations, regenerateCommand } };
		taken.push("migrations.regenerateCommand");
	}
	return { defaults, taken };
}

/**
 * The project defaults a dispatch runs with. Unchanged unless the refresh
 * resolved a non-default base (`baseSha`), in which case the base's
 * branch-sourced keys are laid over them.
 */
export async function withBranchDefaults(
	input: Pick<SpawnRunInput, "projectSpawn" | "projectsConfig" | "logger">,
	refreshed: RefreshProjectResult | null,
	main: DefaultsConfig | null,
): Promise<DefaultsConfig | null> {
	if (refreshed?.baseSha === undefined || input.projectSpawn === undefined) return main;
	const baseSha = refreshed.baseSha;
	const branch = await readBranchDefaults({
		spawn: input.projectSpawn,
		gitBinary: input.projectsConfig?.gitBinary ?? "git",
		projectPath: refreshed.project.localPath,
		baseSha,
	});
	if (branch.errors.length > 0) {
		input.logger?.warn(
			{ base_ref: refreshed.ref, base_sha: baseSha, errors: branch.errors },
			"spawn.branch_config_unusable",
		);
		return main;
	}
	const overlay = applyBranchDefaults(main, branch.defaults);
	if (overlay.taken.length > 0) {
		input.logger?.info(
			{ base_ref: refreshed.ref, base_sha: baseSha, keys: overlay.taken },
			"spawn.branch_config_overlay",
		);
	}
	return overlay.defaults;
}

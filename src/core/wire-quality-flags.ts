/**
 * Shortcut-flag vocabulary (namphuongtran/warren#37), re-exported from
 * wire.ts so the canonical home stays one module.
 *
 * At reap, Warren scans the run's `base..head` diff and the git commands
 * the agent ran for cheap, deterministic signs that it worked around a
 * gate instead of fixing the cause. A flag is a signal for a reviewer,
 * never a failure: core records flags and acts on none of them.
 *
 * - `suppression` — an added line carries a lint or type suppression
 *   (`@ts-expect-error`, `biome-ignore`, `eslint-disable`, `noqa`, …).
 * - `skipped_test` — an added line skips or parks a test (`.skip(`,
 *   `xit(`, `test.todo(`, `@pytest.mark.skip`, …).
 * - `deleted_test` — the diff deletes a test file.
 * - `assertions_removed` — a test file loses more assertion lines than it gains.
 * - `protected_file` — the diff edits a file matching the project's
 *   protected-path globs (ratchets, budgets, allowlists).
 * - `hook_bypass` — the agent ran a git command with `--no-verify`.
 */
export const RUN_QUALITY_FLAG_KINDS = [
	"suppression",
	"skipped_test",
	"deleted_test",
	"assertions_removed",
	"protected_file",
	"hook_bypass",
] as const;
export type RunQualityFlagKind = (typeof RUN_QUALITY_FLAG_KINDS)[number];

/** One shortcut signal, located as precisely as the source allows. */
export interface RunQualityFlag {
	readonly kind: RunQualityFlagKind;
	/** Repo-relative path in the head tree (the old path for a deleted file); null for a command. */
	readonly path: string | null;
	/** 1-based line in the head version of `path`; null for a whole-file or command flag. */
	readonly line: number | null;
	/** What matched: the marker (`@ts-expect-error`), the glob, a count, or the git command. */
	readonly detail: string;
}

/**
 * The flags reap recorded for a run, served on `GET /runs/:id` and the runs
 * list. `flags` is capped; `omitted` counts the flags past the cap. The run's
 * `qualityFlags` is null when reap could not read the diff (not scanned).
 */
export interface RunQualityFlags {
	readonly flags: readonly RunQualityFlag[];
	readonly omitted: number;
}

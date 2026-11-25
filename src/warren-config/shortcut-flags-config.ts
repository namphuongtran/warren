/**
 * Per-project shortcut-flag config (namphuongtran/warren#37):
 * `shortcutFlags: { protectedPaths }` in `.warren/config.yaml`.
 *
 * Reap flags a run whose diff edits a file matching one of these globs
 * (ratchets, budgets, allowlists). The list replaces the built-in default
 * (`DEFAULT_PROTECTED_PATHS` in `src/runs/shortcut-flags/scan.ts`); `[]`
 * turns the protected-file flag off. Dispatch freezes the list onto the run.
 */

import { z } from "zod";

export const ShortcutFlagsConfigSchema = z
	.object({
		protectedPaths: z
			.array(z.string().min(1, "a protectedPaths glob must be non-empty").max(256))
			.max(64, "protectedPaths takes at most 64 globs")
			.optional(),
	})
	.strict();

export type ShortcutFlagsConfig = z.infer<typeof ShortcutFlagsConfigSchema>;

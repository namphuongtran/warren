/**
 * Context windows of the Claude models (namphuongtran/warren#20), shared by
 * the adapters whose harness runs them: claude-code and pi.
 *
 * No harness stream carries the window mid-run. claude-code names it only in
 * its final `result` line (`modelUsage[model].contextWindow`), and pi never
 * does. The warning has to fire before the run ends, so the window comes from
 * this table. Each value is the one claude-code itself reported (CLI 2.1.332,
 * 2026-11-27), and `./claude-code-context.capture.test.ts` pins the table to
 * those `result` lines. A model the table does not list is unknown: it gets no
 * reading and no warning, never a guessed window. A guess too small would warn
 * a run at a fraction of its real window; one too large would never warn.
 */

/** Window per model family. The API's dated snapshot ids map onto these keys. */
const CLAUDE_CONTEXT_WINDOWS: ReadonlyMap<string, number> = new Map([
	["claude-opus-5-5", 1_000_000],
	["claude-sonnet-5-5", 1_000_000],
	["claude-haiku-5-5", 1_000_000],
	["claude-opus-4-5", 200_000],
	["claude-sonnet-4-5", 200_000],
	["claude-haiku-4-5", 200_000],
]);

/** claude-code's model syntax for the 1M window (`claude-sonnet-4-5[1m]`). */
const ONE_MILLION_SUFFIX = /\[1m\]$/;
const ONE_MILLION_WINDOW_TOKENS = 1_000_000;
/** The API names a dated snapshot (`claude-sonnet-4-5-20250929`). */
const SNAPSHOT_DATE_SUFFIX = /-\d{8}$/;

/** True when `model` selects the 1M window explicitly. */
export function selectsOneMillionWindow(model: string): boolean {
	return ONE_MILLION_SUFFIX.test(model.trim().toLowerCase());
}

/**
 * The context window of a Claude `model`, or `null` when the table does not
 * know it. Accepts a routed id (`anthropic/claude-sonnet-5-5`, pi), a dated
 * snapshot id (the API's `message.model`), and the `[1m]` suffix.
 */
export function claudeContextWindowTokens(model: string): number | null {
	const id = model
		.slice(model.lastIndexOf("/") + 1)
		.trim()
		.toLowerCase();
	if (!id.startsWith("claude-")) return null;
	if (ONE_MILLION_SUFFIX.test(id)) return ONE_MILLION_WINDOW_TOKENS;
	return CLAUDE_CONTEXT_WINDOWS.get(id.replace(SNAPSHOT_DATE_SUFFIX, "")) ?? null;
}

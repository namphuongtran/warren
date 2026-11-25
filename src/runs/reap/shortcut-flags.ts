/**
 * Reap step for the shortcut flags (namphuongtran/warren#37).
 *
 * The outcome-facts step reads the run's `base..head` unified diff beside
 * the numstat totals. This step scans it, with the protected-path globs
 * frozen on the run at dispatch and the git commands the agent ran, stores
 * the flags on the run row, and emits `quality.flags`.
 *
 * Flags are signals, never failures: nothing here changes the run's outcome,
 * and a policy that blocks merge on a flag lives outside core. Best-effort
 * bookkeeping, like the gate outcome: a failure is logged and never thrown
 * out of reap, and the row keeps NULL ("not scanned").
 */

import type { Repos } from "../../db/repos/index.ts";
import type { EventRow, RunRow } from "../../db/schema.ts";
import { runtimeFromRenderedAgent } from "../analytics/tool-call-extract.ts";
import { readToolCommands } from "../quality-gate/outcome.ts";
import { DEFAULT_PROTECTED_PATHS, scanShortcutFlags } from "../shortcut-flags/scan.ts";
import type { BoundBridgeLogger } from "../stream/index.ts";

/** The system event reap emits with the recorded flags. */
export const QUALITY_FLAGS_KIND = "quality.flags";

/** The slice of the reap pipeline context this step reads. */
export interface ShortcutFlagsStepContext {
	readonly input: {
		readonly repos: {
			readonly runs: Pick<Repos["runs"], "setQualityFlags">;
			readonly events: Pick<Repos["events"], "listToolEventsForRun">;
		};
	};
	readonly run: Pick<RunRow, "id" | "renderedAgentJson" | "protectedPaths">;
	readonly emit: (kind: string, payload: unknown) => Promise<EventRow>;
	readonly log: BoundBridgeLogger;
}

/**
 * Scan, store, and announce the run's shortcut flags. `diff` is the unified
 * diff the outcome-facts step read; null means it could not be read, and the
 * run is left unscanned.
 */
export async function recordShortcutFlags(
	ctx: ShortcutFlagsStepContext,
	diff: string | null,
): Promise<void> {
	if (diff === null) return;
	const { run } = ctx;
	try {
		const events = await ctx.input.repos.events.listToolEventsForRun(run.id);
		const flags = scanShortcutFlags({
			diff,
			protectedPaths: run.protectedPaths ?? DEFAULT_PROTECTED_PATHS,
			commands: readToolCommands(
				runtimeFromRenderedAgent(run.renderedAgentJson),
				events.map((ev) => ({ kind: ev.kind, payload: ev.payloadJson })),
			),
		});
		await ctx.input.repos.runs.setQualityFlags(run.id, flags);
		await ctx.emit(QUALITY_FLAGS_KIND, flags);
	} catch (err) {
		ctx.log.warn(
			{
				event: "reap.quality_flags_failed",
				runId: run.id,
				err: err instanceof Error ? err.message : String(err),
			},
			"shortcut flags could not be recorded",
		);
	}
}

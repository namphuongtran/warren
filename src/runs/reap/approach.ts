/**
 * Reap step for the run approach note (namphuongtran/warren#33).
 *
 * finalize reads `.warren/approach.md` off the workspace on every provider
 * and hands the body back (`FinalizeResult.approachBody`). This step reads it
 * through `parseRunApproach`, stores the result on the run row, and emits
 * `approach.recorded` or `approach.missing`.
 *
 * A note is recorded whenever one exists. Its absence is flagged only when
 * the dispatched agent's prompt asked for one (the source-editing builtins,
 * or a custom agent that adopts the convention), so a reviewer or planner
 * run never reads as "missing". The flag is informational: it never changes
 * the run's outcome.
 *
 * Best-effort bookkeeping, like the handoff step: a storage failure is logged
 * and never thrown out of reap.
 */

import { parseRunApproach, RUN_APPROACH_PATH } from "../../core/wire.ts";
import type { Repos } from "../../db/repos/index.ts";
import type { EventRow, RunRow } from "../../db/schema.ts";
import type { BoundBridgeLogger } from "../stream/index.ts";

/** Emitted with the stored note when the run wrote one. */
export const APPROACH_RECORDED_KIND = "approach.recorded";
/** Emitted with the reason when an asked-for note is absent or empty. */
export const APPROACH_MISSING_KIND = "approach.missing";

/** The slice of the reap pipeline context this step reads. */
export interface ApproachStepContext {
	readonly input: { readonly repos: { readonly runs: Pick<Repos["runs"], "setApproach"> } };
	readonly run: Pick<RunRow, "id" | "renderedAgentJson">;
	readonly emit: (kind: string, payload: unknown) => Promise<EventRow>;
	readonly log: BoundBridgeLogger;
}

/** True when the run's frozen agent definition tells the agent to write the note. */
function agentAskedForApproach(renderedAgentJson: unknown): boolean {
	const sections = (renderedAgentJson as { sections?: { system?: unknown } } | null)?.sections;
	return typeof sections?.system === "string" && sections.system.includes(RUN_APPROACH_PATH);
}

/**
 * Store and announce the run's approach note. `body` is the collected file;
 * null/undefined means the file was absent.
 */
export async function recordApproach(
	ctx: ApproachStepContext,
	body: string | null | undefined,
): Promise<void> {
	const record = parseRunApproach(body ?? null);
	if (record.state === "missing" && !agentAskedForApproach(ctx.run.renderedAgentJson)) return;
	try {
		await ctx.input.repos.runs.setApproach(ctx.run.id, record);
		if (record.state === "recorded") {
			await ctx.emit(APPROACH_RECORDED_KIND, {
				markdown: record.markdown,
				truncated: record.truncated,
			});
		} else {
			await ctx.emit(APPROACH_MISSING_KIND, { reason: record.reason });
		}
	} catch (err) {
		ctx.log.warn(
			{
				event: "reap.approach_record_failed",
				runId: ctx.run.id,
				err: err instanceof Error ? err.message : String(err),
			},
			"approach note could not be recorded",
		);
	}
}

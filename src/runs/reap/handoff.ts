/**
 * Reap step for the run handoff report (namphuongtran/warren#21).
 *
 * finalize reads `.warren/handoff.json` off the workspace on every provider
 * and hands the body back (`FinalizeResult.handoffBody`). This step validates
 * it, stores the result on the run row, and emits `handoff.recorded` or
 * `handoff.missing`. The PR-open step renders the same record into the PR
 * body, and `reapRun` fails the run when the project requires a handoff and
 * none was recorded.
 *
 * Best-effort bookkeeping, like the quality-gate outcome: a storage failure
 * is logged and never thrown out of reap. The returned record still drives
 * the PR body and the required-handoff check.
 */

import { parseRunHandoff, type RunHandoffRecord } from "../../core/wire.ts";
import type { Repos } from "../../db/repos/index.ts";
import type { EventRow } from "../../db/schema.ts";
import type { BoundBridgeLogger } from "../stream/index.ts";

/** Emitted with the validated report when the run left a valid handoff. */
export const HANDOFF_RECORDED_KIND = "handoff.recorded";
/** Emitted with the reason when the handoff is missing or invalid. */
export const HANDOFF_MISSING_KIND = "handoff.missing";

export interface RecordHandoffInput {
	readonly runs: Pick<Repos["runs"], "setHandoff">;
	readonly runId: string;
	/** The collected file body; null/undefined = the file was absent. */
	readonly body: string | null | undefined;
	/** The project requires a handoff; carried on the missing event. */
	readonly required: boolean;
	readonly emit: (kind: string, payload: unknown) => Promise<EventRow>;
	readonly log: BoundBridgeLogger;
}

/** Validate, persist, and announce the run's handoff report. */
export async function recordHandoff(input: RecordHandoffInput): Promise<RunHandoffRecord> {
	const record = parseRunHandoff(input.body ?? null);
	try {
		await input.runs.setHandoff(input.runId, record);
		if (record.state === "recorded") {
			await input.emit(HANDOFF_RECORDED_KIND, record.handoff);
		} else {
			await input.emit(HANDOFF_MISSING_KIND, {
				state: record.state,
				reason: record.reason,
				required: input.required,
			});
		}
	} catch (err) {
		input.log.warn(
			{
				event: "reap.handoff_record_failed",
				runId: input.runId,
				err: err instanceof Error ? err.message : String(err),
			},
			"handoff report could not be recorded",
		);
	}
	return record;
}

/** True when a required handoff is absent or invalid. */
export function isHandoffShortfall(
	record: RunHandoffRecord | null,
	required: boolean | undefined,
): boolean {
	return required === true && record !== null && record.state !== "recorded";
}

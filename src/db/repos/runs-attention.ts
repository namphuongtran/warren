/**
 * The needs-attention reads (namphuongtran/warren#26), extracted from
 * `RunsRepo` under the file-size budget like `runs-queries.ts`.
 */

import { and, desc, gte, inArray, isNotNull, ne, or } from "drizzle-orm";
import type { RunAttentionRun, RunTriggerKind } from "../../core/wire.ts";
import type { SqliteDrizzleDb } from "../client.ts";
import type { DrizzleAdapter } from "./drizzle-adapter.ts";

/** A CI fix continues a run's PR without settling the run's own signals. */
const CI_FIX_TRIGGER = "ci-fixer" satisfies RunTriggerKind;

/** What the needs-attention list derives from. */
export interface RunAttentionInputs {
	/** Succeeded and failed runs queued since the cutoff, newest first. */
	readonly runs: readonly RunAttentionRun[];
	/** Ids among them that a retry or a re-dispatch already followed up. */
	readonly redispatched: ReadonlySet<string>;
}

/**
 * Read the runs queued at or after `createdSinceMs` that may need the
 * operator, and which of them a later run followed up. A run's retries and
 * re-dispatches are queued after it, so they fall inside the same window. A CI
 * fix continues the run's PR without settling the run's own signals, so it
 * does not count as a follow-up. Only the columns the list shows are read.
 */
export async function readAttentionInputs(
	adapter: DrizzleAdapter,
	createdSinceMs: number,
): Promise<RunAttentionInputs> {
	const db = adapter.drizzle as SqliteDrizzleDb;
	const runs = adapter.schema.runs;
	const rows = await adapter.pickAll<RunAttentionRun>(
		db
			.select({
				id: runs.id,
				agentName: runs.agentName,
				projectId: runs.projectId,
				state: runs.state,
				failureReason: runs.failureReason,
				trigger: runs.trigger,
				prompt: runs.prompt,
				createdAt: runs.createdAt,
				endedAt: runs.endedAt,
				prUrl: runs.prUrl,
				prState: runs.prState,
				prChecks: runs.prChecks,
				qualityGateOutcome: runs.qualityGateOutcome,
				qualityFlags: runs.qualityFlags,
				handoff: runs.handoff,
			})
			.from(runs)
			.where(and(inArray(runs.state, ["succeeded", "failed"]), gte(runs.createdAt, createdSinceMs)))
			.orderBy(desc(runs.createdAt), desc(runs.id)),
	);
	const links = await adapter.pickAll<{ parentRunId: string | null; retryOf: string | null }>(
		db
			.select({ parentRunId: runs.parentRunId, retryOf: runs.retryOf })
			.from(runs)
			.where(
				and(
					gte(runs.createdAt, createdSinceMs),
					or(
						isNotNull(runs.retryOf),
						and(isNotNull(runs.parentRunId), ne(runs.trigger, CI_FIX_TRIGGER)),
					),
				),
			),
	);
	const redispatched = new Set<string>();
	for (const link of links) {
		if (link.retryOf !== null) redispatched.add(link.retryOf);
		if (link.parentRunId !== null) redispatched.add(link.parentRunId);
	}
	return { runs: rows, redispatched };
}

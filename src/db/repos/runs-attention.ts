/**
 * The needs-attention reads (namphuongtran/warren#26), extracted from
 * `RunsRepo` under the file-size budget like `runs-queries.ts`.
 */

import { and, desc, gte, inArray, isNotNull, ne, or, type SQL } from "drizzle-orm";
import type { RunAttentionRun, RunTriggerKind } from "../../core/wire.ts";
import type { SqliteDrizzleDb } from "../client.ts";
import type { DrizzleAdapter } from "./drizzle-adapter.ts";

/** A CI fix continues a run's PR without settling the run's own signals. */
const CI_FIX_TRIGGER = "ci-fixer" satisfies RunTriggerKind;

type RunsTable = DrizzleAdapter["schema"]["runs"];

/** What the needs-attention list derives from. */
export interface RunAttentionInputs {
	/** Succeeded and failed runs queued since the cutoff, newest first. */
	readonly runs: readonly RunAttentionRun[];
	/** Ids among them that a retry or a re-dispatch already followed up. */
	readonly redispatched: ReadonlySet<string>;
}

/** The facts one runs-list page needs beyond its own rows (namphuongtran/warren#39). */
export interface RunAttentionLinks {
	/** Ids among the page's runs that a retry or a re-dispatch already followed up. */
	readonly redispatched: ReadonlySet<string>;
	/** The succeeded and failed runs on the page's PRs, newest first. */
	readonly runsOnPrs: readonly { readonly id: string; readonly prUrl: string | null }[];
}

/** A run that follows another up: a retry, or a re-dispatch other than a CI fix. */
function isFollowUp(runs: RunsTable): SQL | undefined {
	return or(
		isNotNull(runs.retryOf),
		and(isNotNull(runs.parentRunId), ne(runs.trigger, CI_FIX_TRIGGER)),
	);
}

/** Read follow-up rows matching `where` and collect the ids they follow up. */
async function readRedispatched(
	adapter: DrizzleAdapter,
	where: SQL | undefined,
): Promise<Set<string>> {
	const db = adapter.drizzle as SqliteDrizzleDb;
	const runs = adapter.schema.runs;
	const links = await adapter.pickAll<{ parentRunId: string | null; retryOf: string | null }>(
		db.select({ parentRunId: runs.parentRunId, retryOf: runs.retryOf }).from(runs).where(where),
	);
	const redispatched = new Set<string>();
	for (const link of links) {
		if (link.retryOf !== null) redispatched.add(link.retryOf);
		if (link.parentRunId !== null) redispatched.add(link.parentRunId);
	}
	return redispatched;
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
	const redispatched = await readRedispatched(
		adapter,
		and(gte(runs.createdAt, createdSinceMs), isFollowUp(runs)),
	);
	return { runs: rows, redispatched };
}

/**
 * Read the links one runs-list page needs to judge its rows the way
 * {@link readAttentionInputs} lets the Needs attention page judge them: which
 * of `runIds` a later run followed up, and the finished runs on `prUrls` in the
 * page's order. Both reads stay inside the same window, so a row is judged
 * against the same runs the page would see.
 */
export async function readAttentionLinks(
	adapter: DrizzleAdapter,
	page: {
		readonly runIds: readonly string[];
		readonly prUrls: readonly string[];
		readonly createdSinceMs: number;
	},
): Promise<RunAttentionLinks> {
	const db = adapter.drizzle as SqliteDrizzleDb;
	const runs = adapter.schema.runs;
	const ids = [...page.runIds];
	const redispatched =
		ids.length === 0
			? new Set<string>()
			: await readRedispatched(
					adapter,
					and(
						gte(runs.createdAt, page.createdSinceMs),
						or(inArray(runs.retryOf, ids), inArray(runs.parentRunId, ids)),
						isFollowUp(runs),
					),
				);
	if (page.prUrls.length === 0) return { redispatched, runsOnPrs: [] };
	const runsOnPrs = await adapter.pickAll<{ id: string; prUrl: string | null }>(
		db
			.select({ id: runs.id, prUrl: runs.prUrl })
			.from(runs)
			.where(
				and(
					inArray(runs.prUrl, [...page.prUrls]),
					inArray(runs.state, ["succeeded", "failed"]),
					gte(runs.createdAt, page.createdSinceMs),
				),
			)
			.orderBy(desc(runs.createdAt), desc(runs.id)),
	);
	return { redispatched, runsOnPrs };
}

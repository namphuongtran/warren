/**
 * Reap-time outcome facts (warren-ab2b / pl-103e), extracted from
 * `RunsRepo` to keep `runs.ts` under the file-size budget — same posture
 * as `runs-ci-fixer.ts`. `RunsRepo.setOutcomeFacts` delegates here so the
 * call surface is unchanged.
 */

import { eq } from "drizzle-orm";
import { NotFoundError } from "../../core/errors.ts";
import type { SqliteDrizzleDb } from "../client.ts";
import type {
	RunApproachRecord,
	RunHandoffRecord,
	RunQualityFlags,
	RunQualityGateOutcome,
	RunRow,
} from "../schema.ts";
import type { DrizzleAdapter } from "./drizzle-adapter.ts";

/**
 * The facts the reap pipeline measured at finalize. Every numeric field is
 * `number | null`: NULL means unknown (skipped/failed finalize,
 * unmeasurable diff, pre-column row), never zero. `baseSha` is the resolved
 * workspace base SHA (warren-b19e) — the merge-base of the diff base and the
 * workspace HEAD, read where commits_ahead is measured; null = unmeasurable.
 */
export interface RunOutcomeFacts {
	readonly commitsAhead: number | null;
	readonly baseSha: string | null;
	readonly filesChanged: number | null;
	readonly insertions: number | null;
	readonly deletions: number | null;
}

/**
 * Persist the reap-time outcome facts onto the run row. Last write wins —
 * a re-reap overwrites with its own measurement. Facts are recorded, not
 * interpreted: the caller passes what it measured and NULL for what it
 * could not.
 */
export async function setOutcomeFacts(
	adapter: DrizzleAdapter,
	id: string,
	facts: RunOutcomeFacts,
): Promise<RunRow> {
	const db = adapter.drizzle as SqliteDrizzleDb;
	const runs = adapter.schema.runs;
	const current = await adapter.pickOne<RunRow>(db.select().from(runs).where(eq(runs.id, id)));
	if (!current) throw new NotFoundError(`run not found: ${id}`);
	const patch = {
		commitsAhead: facts.commitsAhead,
		baseSha: facts.baseSha,
		filesChanged: facts.filesChanged,
		insertions: facts.insertions,
		deletions: facts.deletions,
	};
	await adapter.runWrite(db.update(runs).set(patch).where(eq(runs.id, id)));
	return { ...current, ...patch };
}

/**
 * Stamp the quality-gate outcome reap derived from the run's tool calls
 * (namphuongtran/warren#36). Last write wins, like the outcome facts above.
 */
export async function setQualityGateOutcome(
	adapter: DrizzleAdapter,
	id: string,
	outcome: RunQualityGateOutcome,
): Promise<void> {
	const db = adapter.drizzle as SqliteDrizzleDb;
	const runs = adapter.schema.runs;
	await adapter.runWrite(
		db.update(runs).set({ qualityGateOutcome: outcome }).where(eq(runs.id, id)),
	);
}

/**
 * Store the handoff report reap validated (namphuongtran/warren#21). Last
 * write wins, like the gate outcome above.
 */
export async function setHandoff(
	adapter: DrizzleAdapter,
	id: string,
	record: RunHandoffRecord,
): Promise<void> {
	const db = adapter.drizzle as SqliteDrizzleDb;
	const runs = adapter.schema.runs;
	await adapter.runWrite(db.update(runs).set({ handoff: record }).where(eq(runs.id, id)));
}

/**
 * Store the approach note reap read off the workspace
 * (namphuongtran/warren#33). Last write wins, like the handoff above.
 */
export async function setApproach(
	adapter: DrizzleAdapter,
	id: string,
	record: RunApproachRecord,
): Promise<void> {
	const db = adapter.drizzle as SqliteDrizzleDb;
	const runs = adapter.schema.runs;
	await adapter.runWrite(db.update(runs).set({ approach: record }).where(eq(runs.id, id)));
}

/**
 * Store the shortcut flags reap scanned off the run's diff
 * (namphuongtran/warren#37). Last write wins, like the approach note above.
 */
export async function setQualityFlags(
	adapter: DrizzleAdapter,
	id: string,
	flags: RunQualityFlags,
): Promise<void> {
	const db = adapter.drizzle as SqliteDrizzleDb;
	const runs = adapter.schema.runs;
	await adapter.runWrite(db.update(runs).set({ qualityFlags: flags }).where(eq(runs.id, id)));
}

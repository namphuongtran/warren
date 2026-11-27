/**
 * Repository for the `run_context` runtime-state table
 * (namphuongtran/warren#20). One row per run holding the newest
 * context-window reading. The event bridge records each reading as it
 * streams; a resumed bridge can replay an older one, so
 * {@link RunContextRepo.record} keeps whichever reading is newest by
 * `observed_at` instead of whichever wrote last.
 */

import { eq, sql } from "drizzle-orm";
import type { SqliteDrizzleDb } from "../client.ts";
import type { RunContextInsert, RunContextRow } from "../schema.ts";
import type { DrizzleAdapter } from "./drizzle-adapter.ts";

export class RunContextRepo {
	constructor(private readonly adapter: DrizzleAdapter) {}

	private get db(): SqliteDrizzleDb {
		return this.adapter.drizzle as SqliteDrizzleDb;
	}

	private get table() {
		return this.adapter.schema.runContext;
	}

	/** Upsert a reading; one older than the stored reading is a no-op. */
	async record(row: RunContextInsert): Promise<void> {
		const t = this.table;
		await this.adapter.runWrite(
			this.db
				.insert(t)
				.values(row)
				.onConflictDoUpdate({
					target: t.runId,
					set: {
						tokensUsed: row.tokensUsed,
						windowTokens: row.windowTokens,
						model: row.model,
						observedAt: row.observedAt,
					},
					setWhere: sql`${t.observedAt} <= ${row.observedAt}`,
				}),
		);
	}

	async get(runId: string): Promise<RunContextRow | undefined> {
		const t = this.table;
		return await this.adapter.pickOne<RunContextRow>(
			this.db.select().from(t).where(eq(t.runId, runId)),
		);
	}
}

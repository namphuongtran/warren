/**
 * Repository for the `provider_quota` runtime-state table
 * (namphuongtran/warren#30). One row per (provider, credential fingerprint)
 * holding the newest usage-window report. Reports race in from several
 * bridges and from reap, so {@link ProviderQuotaRepo.record} keeps whichever
 * report is newest by `observed_at` instead of whichever wrote last.
 */

import { and, asc, eq, sql } from "drizzle-orm";
import type { SqliteDrizzleDb } from "../client.ts";
import type { ProviderQuotaInsert, ProviderQuotaRow } from "../schema.ts";
import type { DrizzleAdapter } from "./drizzle-adapter.ts";

export class ProviderQuotaRepo {
	constructor(private readonly adapter: DrizzleAdapter) {}

	private get db(): SqliteDrizzleDb {
		return this.adapter.drizzle as SqliteDrizzleDb;
	}

	private get table() {
		return this.adapter.schema.providerQuota;
	}

	/** Upsert a report; one older than the stored report is a no-op. */
	async record(row: ProviderQuotaInsert): Promise<void> {
		const t = this.table;
		await this.adapter.runWrite(
			this.db
				.insert(t)
				.values(row)
				.onConflictDoUpdate({
					target: [t.provider, t.credentialFingerprint],
					set: {
						status: row.status,
						utilization: row.utilization ?? null,
						rateLimitType: row.rateLimitType ?? null,
						resetsAt: row.resetsAt ?? null,
						source: row.source,
						sourceRunId: row.sourceRunId ?? null,
						observedAt: row.observedAt,
					},
					setWhere: sql`${t.observedAt} <= ${row.observedAt}`,
				}),
		);
	}

	async get(
		provider: string,
		credentialFingerprint: string,
	): Promise<ProviderQuotaRow | undefined> {
		const t = this.table;
		return await this.adapter.pickOne<ProviderQuotaRow>(
			this.db
				.select()
				.from(t)
				.where(and(eq(t.provider, provider), eq(t.credentialFingerprint, credentialFingerprint))),
		);
	}

	async list(): Promise<ProviderQuotaRow[]> {
		const t = this.table;
		return await this.adapter.pickAll<ProviderQuotaRow>(
			this.db.select().from(t).orderBy(asc(t.provider), asc(t.credentialFingerprint)),
		);
	}
}

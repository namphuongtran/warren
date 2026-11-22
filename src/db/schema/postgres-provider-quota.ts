/**
 * Provider usage-window state (namphuongtran/warren#30) — mirror of
 * `./sqlite-provider-quota.ts`, re-exported by `./postgres.ts`.
 */

import { bigint, doublePrecision, pgTable, primaryKey, text } from "drizzle-orm/pg-core";
import { PROVIDER_QUOTA_SOURCES, TABLE_NAMES } from "./columns.ts";

export const providerQuota = pgTable(
	TABLE_NAMES.providerQuota,
	{
		provider: text("provider").notNull(),
		credentialFingerprint: text("credential_fingerprint").notNull(),
		status: text("status").notNull(),
		utilization: doublePrecision("utilization"),
		rateLimitType: text("rate_limit_type"),
		// Unix seconds; bigint so the column outlives pg's 32-bit integer.
		resetsAt: bigint("resets_at", { mode: "number" }),
		source: text("source", { enum: PROVIDER_QUOTA_SOURCES }).notNull(),
		sourceRunId: text("source_run_id"),
		observedAt: text("observed_at").notNull(),
	},
	(t) => [primaryKey({ columns: [t.provider, t.credentialFingerprint] })],
);

export type ProviderQuotaRow = typeof providerQuota.$inferSelect;
export type ProviderQuotaInsert = typeof providerQuota.$inferInsert;

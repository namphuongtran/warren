/**
 * Provider usage-window state (namphuongtran/warren#30). Runtime state, one
 * row per (provider, credential fingerprint): the newest `rate_limit_event`
 * or `quota_exhausted` reap observed for that credential. The fingerprint is
 * a one-way hash (`src/runs/quota/fingerprint.ts`); the secret is never
 * stored. `observed_at` is ISO8601 TEXT and decides which report is newest.
 *
 * Its own module because `./sqlite.ts` is at its size budget; `./sqlite.ts`
 * re-exports it, so drizzle-kit and the adapter see one schema.
 */

import { integer, primaryKey, real, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { PROVIDER_QUOTA_SOURCES, TABLE_NAMES } from "./columns.ts";

export const providerQuota = sqliteTable(
	TABLE_NAMES.providerQuota,
	{
		provider: text("provider").notNull(),
		credentialFingerprint: text("credential_fingerprint").notNull(),
		status: text("status").notNull(),
		utilization: real("utilization"),
		rateLimitType: text("rate_limit_type"),
		resetsAt: integer("resets_at"),
		source: text("source", { enum: PROVIDER_QUOTA_SOURCES }).notNull(),
		sourceRunId: text("source_run_id"),
		observedAt: text("observed_at").notNull(),
	},
	(t) => [primaryKey({ columns: [t.provider, t.credentialFingerprint] })],
);

export type ProviderQuotaRow = typeof providerQuota.$inferSelect;
export type ProviderQuotaInsert = typeof providerQuota.$inferInsert;

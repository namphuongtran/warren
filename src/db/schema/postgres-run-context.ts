/**
 * The newest context-window reading per run (namphuongtran/warren#20) —
 * mirror of `./sqlite-run-context.ts`, re-exported by `./postgres.ts`.
 */

import { integer, pgTable, text } from "drizzle-orm/pg-core";
import { TABLE_NAMES } from "./columns.ts";
import { runs } from "./postgres.ts";

export const runContext = pgTable(TABLE_NAMES.runContext, {
	runId: text("run_id")
		.primaryKey()
		.references(() => runs.id, { onDelete: "cascade" }),
	tokensUsed: integer("tokens_used").notNull(),
	windowTokens: integer("window_tokens").notNull(),
	model: text("model").notNull(),
	observedAt: text("observed_at").notNull(),
});

export type RunContextRow = typeof runContext.$inferSelect;
export type RunContextInsert = typeof runContext.$inferInsert;

/**
 * The newest context-window reading per run (namphuongtran/warren#20).
 * Runtime state, one row per run, upserted by the event bridge each time the
 * harness reports how full the model's context window is. The run detail's
 * Spend panel reads it. The readings are not events: claude-code reports one
 * per API request, which would crowd the transcript, and only the newest one
 * matters. `observed_at` is ISO8601 TEXT and decides which reading is newest.
 *
 * Its own module because `./sqlite.ts` is at its size budget; `./sqlite.ts`
 * re-exports it, so drizzle-kit and the adapter see one schema. The import of
 * `runs` back from `./sqlite.ts` is a cycle, which is safe because drizzle
 * resolves the foreign-key target lazily.
 */

import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { TABLE_NAMES } from "./columns.ts";
import { runs } from "./sqlite.ts";

export const runContext = sqliteTable(TABLE_NAMES.runContext, {
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

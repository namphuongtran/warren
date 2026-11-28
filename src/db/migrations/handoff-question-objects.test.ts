/**
 * Migration 0064 (sqlite) / 0059 (postgres): rewrite stored handoff open
 * questions from bare strings to question objects (namphuongtran/warren#25).
 *
 * Handoffs recorded before #25 store `openQuestions` as strings. The wire
 * shape is now `{ question, options, recommendation }`, so the migration
 * converts each string in place and keeps the order. Each test opens a fully
 * migrated database, writes rows in the old shape, and replays the migration
 * SQL against them. That replay also proves the migration is idempotent: rows
 * already in the new shape come through unchanged.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AnyWarrenDb } from "../client.ts";
import { createRepos } from "../repos/index.ts";
import { isPostgresTestEnabled, withDb } from "../testing.ts";

const MIGRATION_SQL = {
	sqlite: join(import.meta.dir, "0064_handoff_question_objects.sql"),
	postgres: join(import.meta.dir, "postgres", "0059_handoff_question_objects.sql"),
} as const;

const LEGACY = {
	state: "recorded",
	handoff: {
		status: "blocked",
		summary: "The card has no progress slot.",
		verification: [{ command: "bun run typecheck", outcome: "passed" }],
		howToTry: [],
		openQuestions: ["Grow a progress slot?", "Keep the sort header?"],
	},
};

const CURRENT = {
	state: "recorded",
	handoff: {
		status: "blocked",
		summary: "Needs a decision.",
		verification: [],
		howToTry: [],
		openQuestions: [
			{ question: "Drop the index?", options: ["Drop it", "Keep it"], recommendation: "Keep it." },
		],
	},
};

const MISSING = { state: "missing", reason: "the run did not write .warren/handoff.json" };

/** Write `handoff_json` verbatim, bypassing the typed repo, as an old build would have. */
async function writeRaw(db: AnyWarrenDb, runId: string, record: unknown): Promise<void> {
	const json = record === null ? null : JSON.stringify(record);
	if (db.dialect === "sqlite") {
		db.raw.query("UPDATE runs SET handoff_json = ? WHERE id = ?").run(json, runId);
	} else {
		await db.raw.query("UPDATE runs SET handoff_json = $1::jsonb WHERE id = $2", [json, runId]);
	}
}

async function replayMigration(db: AnyWarrenDb): Promise<void> {
	const sql = readFileSync(MIGRATION_SQL[db.dialect], "utf8");
	for (const stmt of sql.split("--> statement-breakpoint")) {
		const trimmed = stmt.trim();
		if (trimmed.length === 0) continue;
		if (db.dialect === "sqlite") db.raw.exec(trimmed);
		else await db.raw.query(trimmed);
	}
}

async function migrateRows(dialect: "sqlite" | "postgres", records: readonly unknown[]) {
	await using handle = await withDb({ dialect });
	const db = handle.db;
	const repos = createRepos(db);
	const project = await repos.projects.create({
		gitUrl: "https://github.com/os-eco/warren.git",
		localPath: "/data/projects/os-eco/warren",
		defaultBranch: "main",
	});
	const ids: string[] = [];
	for (const record of records) {
		const run = await repos.runs.create({
			agentName: "claude-code",
			projectId: project.id,
			prompt: "move the table onto cards",
			renderedAgentJson: {},
			trigger: "manual",
		});
		await writeRaw(db, run.id, record);
		ids.push(run.id);
	}
	await replayMigration(db);
	const after: unknown[] = [];
	for (const id of ids) after.push((await repos.runs.require(id)).handoff);
	return after;
}

function suite(dialect: "sqlite" | "postgres") {
	test(`${dialect}: rewrites string questions as objects, in order`, async () => {
		const [migrated] = await migrateRows(dialect, [LEGACY]);
		expect(migrated).toEqual({
			...LEGACY,
			handoff: {
				...LEGACY.handoff,
				openQuestions: [
					{ question: "Grow a progress slot?", options: [], recommendation: null },
					{ question: "Keep the sort header?", options: [], recommendation: null },
				],
			},
		});
	});

	test(`${dialect}: leaves new-shape, missing, empty, and absent handoffs unchanged`, async () => {
		const empty = { ...CURRENT, handoff: { ...CURRENT.handoff, openQuestions: [] } };
		const records = [CURRENT, MISSING, empty, null];
		expect(await migrateRows(dialect, records)).toEqual(records);
	});
}

describe("handoff question objects migration (namphuongtran/warren#25)", () => {
	suite("sqlite");
	if (isPostgresTestEnabled()) suite("postgres");
});

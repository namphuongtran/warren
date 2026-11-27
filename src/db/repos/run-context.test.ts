import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import type { SqliteDrizzleDb } from "../client.ts";
import { isPostgresTestEnabled, withDb } from "../testing.ts";
import { AgentsRepo } from "./agents.ts";
import { DrizzleAdapter } from "./drizzle-adapter.ts";
import { ProjectsRepo } from "./projects.ts";
import { RunContextRepo } from "./run-context.ts";
import { RunsRepo } from "./runs.ts";

function reading(observedAt: string, tokensUsed: number) {
	return { tokensUsed, windowTokens: 200_000, model: "claude-sonnet-4-5", observedAt };
}

function suite(dialect: "sqlite" | "postgres"): void {
	describe(`RunContextRepo (${dialect})`, () => {
		const open = async () => {
			const handle = await withDb({ dialect });
			const adapter = DrizzleAdapter.for(handle.db);
			await new AgentsRepo(adapter).upsert({ name: "claude-code", renderedJson: {} });
			const project = await new ProjectsRepo(adapter).create({
				gitUrl: "https://github.com/x/y.git",
				localPath: "/data/projects/x/y",
				defaultBranch: "main",
			});
			const run = await new RunsRepo(adapter).create({
				agentName: "claude-code",
				projectId: project.id,
				renderedAgentJson: {},
				prompt: "x",
				trigger: "manual",
			});
			return { handle, adapter, runContext: new RunContextRepo(adapter), runId: run.id };
		};

		test("returns undefined for a run with no reading", async () => {
			const { handle, runContext, runId } = await open();
			try {
				expect(await runContext.get(runId)).toBeUndefined();
			} finally {
				await handle.close();
			}
		});

		test("keeps the newest reading as readings stream in", async () => {
			const { handle, runContext, runId } = await open();
			try {
				await runContext.record({ runId, ...reading("2026-11-27T10:00:01.000Z", 50_000) });
				await runContext.record({ runId, ...reading("2026-11-27T10:00:02.000Z", 120_000) });

				expect(await runContext.get(runId)).toEqual({
					runId,
					...reading("2026-11-27T10:00:02.000Z", 120_000),
				});
			} finally {
				await handle.close();
			}
		});

		test("ignores an older reading that a resumed bridge replays", async () => {
			const { handle, runContext, runId } = await open();
			try {
				await runContext.record({ runId, ...reading("2026-11-27T10:00:02.000Z", 120_000) });
				await runContext.record({ runId, ...reading("2026-11-27T10:00:01.000Z", 50_000) });

				expect((await runContext.get(runId))?.tokensUsed).toBe(120_000);
			} finally {
				await handle.close();
			}
		});

		test("drops the reading with its run", async () => {
			const { handle, adapter, runContext, runId } = await open();
			try {
				await runContext.record({ runId, ...reading("2026-11-27T10:00:01.000Z", 50_000) });
				const runs = adapter.schema.runs;
				await adapter.runWrite(
					(adapter.drizzle as SqliteDrizzleDb).delete(runs).where(eq(runs.id, runId)),
				);

				expect(await runContext.get(runId)).toBeUndefined();
			} finally {
				await handle.close();
			}
		});
	});
}

suite("sqlite");
if (isPostgresTestEnabled()) suite("postgres");

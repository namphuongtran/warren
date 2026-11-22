/**
 * Shared harness for the quota auto-resume suite (namphuongtran/warren#30):
 * an in-memory DB holding one failed run, a recording `spawnRun` stub, and a
 * resumer wired to an injectable clock. Split out of the suite for the
 * file-size budget, after the `provider-retry.test-fixture.ts` precedent.
 *
 * Not a suite: it registers nothing. A caller wires `afterEach(closeOpenDb)`.
 */

import { openDatabase, type WarrenDb } from "../../db/client.ts";
import { createRepos } from "../../db/repos/index.ts";
import type { spawnRun } from "../spawn/index.ts";
import { createQuotaResumer, type QuotaResumerInput } from "./quota-resume.ts";

export type Repos = ReturnType<typeof createRepos>;
export type SpawnCall = Parameters<typeof spawnRun>[0];

/** The reset of the window in the issue's evidence: 2026-11-22T09:10:00Z. */
export const RESETS_AT = 1795338600;
export const RESET_ISO = "2026-11-22T09:10:00.000Z";
export const REAPED_AT = new Date("2026-11-22T08:50:40.000Z");

let openDb: WarrenDb | null = null;

/** Register with `afterEach` in each suite that uses {@link setup}. */
export function closeOpenDb(): void {
	openDb?.close();
	openDb = null;
}

export interface Fixture {
	repos: Repos;
	runId: string;
	projectId: string;
}

export async function setup(
	opts: {
		resetsAt?: unknown;
		trigger?: string;
		commitsAhead?: number | null;
		failureReason?: "quota_exhausted" | "crashed";
		/** The pushed branch; `"composed"` (default) is `warren/<runId>`. */
		branch?: string | null;
		targetBranch?: string | null;
	} = {},
): Promise<Fixture> {
	const db = await openDatabase({ path: ":memory:" });
	openDb = db;
	const repos = createRepos(db);
	await repos.agents.upsert({ name: "quota-bot", renderedJson: { sections: { system: "x" } } });
	const project = await repos.projects.create({
		gitUrl: "https://github.com/x/y.git",
		localPath: "/data/projects/x/y",
		defaultBranch: "main",
	});
	const run = await createFailedRun(repos, project.id, {
		failureReason: opts.failureReason ?? "quota_exhausted",
		trigger: opts.trigger ?? "manual",
		resetsAt: opts.resetsAt === undefined ? RESETS_AT : opts.resetsAt,
		commitsAhead: opts.commitsAhead ?? null,
		...(opts.targetBranch != null ? { targetBranch: opts.targetBranch } : {}),
	});
	const branch = opts.branch === undefined ? `warren/${run}` : opts.branch;
	if (branch !== null) await repos.runs.setBranch(run, branch);
	return { repos, runId: run, projectId: project.id };
}

export async function createFailedRun(
	repos: Repos,
	projectId: string,
	opts: {
		failureReason: "quota_exhausted" | "crashed";
		trigger: string;
		resetsAt: unknown;
		commitsAhead: number | null;
		targetBranch?: string;
	},
): Promise<string> {
	const run = await repos.runs.create({
		agentName: "quota-bot",
		projectId,
		prompt: "work on sd warren-30",
		renderedAgentJson: { frontmatter: { provider: "anthropic", model: "claude-opus-5-5" } },
		trigger: opts.trigger,
		seedId: "warren-30",
		sandboxId: "bur_aaaaaaaaaaaa",
		sandboxRunId: "run_zzzzzzzzzzzz",
		...(opts.targetBranch !== undefined ? { targetBranch: opts.targetBranch } : {}),
	});
	await repos.runs.markRunning(run.id, new Date("2026-11-22T07:48:00.000Z"));
	await repos.runs.finalize(run.id, "failed", REAPED_AT, opts.failureReason);
	if (opts.commitsAhead !== null) {
		await repos.runs.setOutcomeFacts(run.id, {
			commitsAhead: opts.commitsAhead,
			baseSha: null,
			filesChanged: 1,
			insertions: 1,
			deletions: 0,
		});
	}
	if (opts.failureReason === "quota_exhausted") {
		await appendEvent(repos, run.id, "reap.quota_exhausted", {
			provider: "anthropic",
			model: "claude-opus-5-5",
			httpStatus: 429,
			apiError: "usage_limit_reached",
			rateLimitType: "five_hour",
			resetsAt: opts.resetsAt,
		});
	}
	return run.id;
}

export async function appendEvent(repos: Repos, runId: string, kind: string, payload: unknown) {
	const seq = ((await repos.events.maxSeqForRun(runId)) ?? 0) + 1;
	await repos.events.append({
		runId,
		sandboxEventSeq: seq,
		ts: REAPED_AT.toISOString(),
		kind,
		stream: "system",
		payload,
	});
}

export function stubSpawn(repos: Repos, opts: { throw?: Error } = {}) {
	const calls: SpawnCall[] = [];
	const spawnRunFn = (async (input: SpawnCall) => {
		calls.push(input);
		if (opts.throw !== undefined) throw opts.throw;
		const row = await repos.runs.create({
			agentName: input.agentName,
			projectId: input.projectId,
			prompt: input.prompt,
			renderedAgentJson: {},
			trigger: input.trigger ?? "manual",
			...(input.parentRunId !== undefined ? { parentRunId: input.parentRunId } : {}),
			...(input.cloneKind !== undefined ? { cloneKind: input.cloneKind } : {}),
		});
		return {
			run: row,
			sandbox: { id: "bur_new", workspacePath: "" },
			sandboxRun: { id: "run_new" },
			agent: { name: input.agentName },
		};
	}) as unknown as typeof spawnRun;
	return { spawnRunFn, calls };
}

export function resumer(
	fixture: Fixture,
	clock: { now: Date },
	overrides: Partial<QuotaResumerInput> = {},
) {
	const spawn = stubSpawn(fixture.repos);
	const started: string[] = [];
	const instance = createQuotaResumer({
		repos: fixture.repos,
		runtimeProvider: {} as QuotaResumerInput["runtimeProvider"],
		bridges: { start: (runId: string) => void started.push(runId) },
		projectsConfig: {} as QuotaResumerInput["projectsConfig"],
		projectSpawn: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
		serverEnv: {},
		spawnRunFn: spawn.spawnRunFn,
		now: () => clock.now,
		random: () => 0,
		...overrides,
	});
	return { instance, spawn, started };
}

export async function kinds(fixture: Fixture, runId = fixture.runId): Promise<string[]> {
	const events = await fixture.repos.events.listByRun(runId);
	return events.map((e) => e.kind);
}

export async function lastPayload(fixture: Fixture, kind: string, runId = fixture.runId) {
	const events = await fixture.repos.events.listByRun(runId);
	return events.filter((e) => e.kind === kind).at(-1)?.payloadJson;
}

/**
 * Scheduler dispatches on a spent provider quota (namphuongtran/warren#30).
 * A cron, scheduled-seed or CI-fixer fire that the quota guard refuses is
 * held, the same as `POST /runs` with `onQuotaExhausted: "hold"`: the fire
 * consumes its slot with the held run's id, and no bridge starts until the
 * hold releaser launches the run after the reset.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { openDatabase, type WarrenDb } from "../db/client.ts";
import { createRepos, type Repos } from "../db/repos/index.ts";
import { agents } from "../db/schema.ts";
import { FakeForge } from "../forge/fake/fake-forge.ts";
import type { SpawnFn } from "../projects/clone.ts";
import type { SpawnOrHoldResult, SpawnRunInput } from "../runs/index.ts";
import type { RuntimeProvider } from "../runtime/contract.ts";
import { SeedsTracker } from "../tracker/seeds-tracker.ts";
import type { TriggerSchedulerConfig } from "../triggers/index.ts";
import { createWarrenConfigCache, type LoadedWarrenConfig } from "../warren-config/index.ts";
import { bootScheduler } from "./scheduler.ts";
import type { BridgeRegistry } from "./types.ts";

const NOW = new Date("2026-05-11T00:05:00.000Z");
const RESETS_AT = Math.floor(NOW.getTime() / 1000) + 3600;
const CONFIG: TriggerSchedulerConfig = { tickMs: 60_000, disabled: true, sdBinary: "sd-test" };

interface LogLine {
	readonly obj: Record<string, unknown>;
	readonly msg: string | undefined;
}

describe("bootScheduler on a spent provider quota", () => {
	let db: WarrenDb;
	let repos: Repos;
	let projectId: string;
	let bridgeStarts: string[];
	let logs: LogLine[];
	let spawnCalls: SpawnRunInput[];

	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
		db.drizzle
			.insert(agents)
			.values({
				name: "claude-code",
				renderedJson: { sections: {} },
				registeredAt: "2026-05-10T00:00:00.000Z",
				lastRefreshed: "2026-05-10T00:00:00.000Z",
			})
			.run();
		repos = createRepos(db);
		const project = await repos.projects.create({
			gitUrl: "https://github.com/x/y.git",
			localPath: "/data/projects/x/y",
			defaultBranch: "main",
		});
		projectId = project.id;
		bridgeStarts = [];
		logs = [];
		spawnCalls = [];
	});

	afterEach(async () => {
		await db.close();
	});

	/** A spawn seam whose quota guard always refuses, so every dispatch is held. */
	const holdingSpawn = async (input: SpawnRunInput): Promise<SpawnOrHoldResult> => {
		spawnCalls.push(input);
		const run = await repos.runs.create({
			agentName: input.agentName,
			projectId: input.projectId,
			prompt: input.prompt,
			renderedAgentJson: { sections: {} },
			trigger: input.trigger ?? "manual",
			...(input.seedId !== undefined ? { seedId: input.seedId } : {}),
		});
		const hold = {
			reason: "provider_quota_exhausted" as const,
			resetsAt: RESETS_AT,
			releaseAt: new Date((RESETS_AT + 60) * 1000).toISOString(),
		};
		return { kind: "held", run, hold };
	};

	function boot(config: Partial<LoadedWarrenConfig>, projectSpawn: SpawnFn) {
		const bridges: BridgeRegistry = {
			start(runId) {
				bridgeStarts.push(runId);
			},
			async stopAll() {},
			size: () => 0,
		};
		const record = (obj: Record<string, unknown>, msg?: string) => logs.push({ obj, msg });
		return bootScheduler({
			repos,
			forge: new FakeForge(),
			runtimeProvider: { kind: "stub" } as unknown as RuntimeProvider,
			bridges,
			warrenConfigs: createWarrenConfigCache({
				load: async () => ({
					triggers: null,
					defaults: null,
					prTemplate: null,
					sourceFile: null,
					errors: [],
					warnings: [],
					...config,
				}),
			}),
			projectsConfig: { root: "/data/projects", gitBinary: "git" },
			projectSpawn,
			issueTracker: new SeedsTracker({ sdBinary: "sd-test", spawn: projectSpawn }),
			config: CONFIG,
			logger: { info: record, warn: record, error: record },
			now: () => NOW,
			spawnOrHoldRunFn: holdingSpawn,
			cloneExists: () => true,
		});
	}

	const quietSpawn = (async () => ({ stdout: "", stderr: "", exitCode: 0 })) as SpawnFn;

	test("holds a cron fire and consumes the slot with the held run", async () => {
		await repos.triggers.upsert({
			projectId,
			triggerId: "nightly",
			lastFiredAt: "2026-05-10T12:00:00.000Z",
		});
		const handle = boot(
			{ triggers: [{ id: "nightly", kind: "cron", cron: "0 0 * * *", role: "claude-code" }] },
			quietSpawn,
		);

		const result = await handle.runOnce();
		await handle.stop();

		const fired = result?.cron[0];
		expect(fired?.kind).toBe("fired");
		const heldRunId = fired?.kind === "fired" ? fired.runId : "";
		expect(spawnCalls[0]?.dispatchOrigin).toBe("cron");
		expect(bridgeStarts).toEqual([]);
		const row = await repos.triggers.get({ projectId, triggerId: "nightly" });
		expect(row?.lastFiredAt).toBe(NOW.toISOString());
		const held = logs.find((l) => l.msg === "scheduler.dispatch_held");
		expect(held?.obj).toMatchObject({ runId: heldRunId, resetsAt: RESETS_AT });
	});

	test("holds a scheduled-seed fire and points the seed at the held run", async () => {
		const updates: string[] = [];
		const projectSpawn: SpawnFn = async (cmd) => {
			if (cmd[1] === "update") updates.push(cmd[4] ?? "{}");
			if (cmd[1] !== "list") return { stdout: "", stderr: "", exitCode: 0 };
			const issue = {
				id: "warren-zzzz",
				status: "open",
				title: "Run me",
				extensions: { scheduledFor: "2026-05-10T00:00:00.000Z" },
			};
			return { stdout: JSON.stringify({ issues: [issue] }), stderr: "", exitCode: 0 };
		};
		const handle = boot({ defaults: { defaultRole: "claude-code" } }, projectSpawn);

		const result = await handle.runOnce();
		await handle.stop();

		const fired = result?.scheduled[0];
		expect(fired?.kind).toBe("fired");
		const heldRunId = fired?.kind === "fired" ? fired.runId : "";
		expect(spawnCalls[0]?.dispatchOrigin).toBe("scheduled");
		expect(bridgeStarts).toEqual([]);
		expect(JSON.parse(updates[0] ?? "{}")).toMatchObject({
			lastRunId: heldRunId,
			scheduledFor: null,
		});
	});
});

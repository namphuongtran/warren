/**
 * Shared fixtures for the watchdog test suites (`watchdog.test.ts` +
 * `watchdog-reconcile.test.ts`). Extracted so both stay under the file-size
 * ratchet without duplicating the agent-json / reap-result / provider fakes.
 */

import type { Repos } from "../db/repos/index.ts";
import type { RunHandle, RunStatus, RuntimeProvider } from "../runtime/contract.ts";
import type { ReapRunResult } from "./reap/index.ts";

export const PROJECT_ID = "prj_xxxxxxxxxxxx";

export function makeAgentJson() {
	return {
		name: "claude-code",
		version: 1,
		sections: { system: "be helpful" },
		resolvedFrom: [],
		frontmatter: {},
	};
}

export function fakeReapResult(state: ReapRunResult["state"]): ReapRunResult {
	return {
		state,
		failureReason: state === "failed" ? "timed_out" : null,
		providerError: null,
		mulchUpdated: 0,
		mulchSkipped: 0,
		mulchAppended: 0,
		seedsClosed: 0,
		seedsCreated: 0,
		seedsCommitted: false,
		branchPushed: false,
		commitsAhead: null,
		prUrl: null,
		previewState: null,
		previewPort: null,
		previewUrl: null,
		autoPlanRunCreated: false,
		autoPlanRunId: null,
		autoPlanRunPlanId: null,
		workspaceDestroyed: true,
		salvageRescueRef: null,
		salvagePath: null,
		errors: [],
		alreadyTerminal: false,
	};
}

/**
 * Fake `RuntimeProvider` that records the graceful-cancel target (warren-1f56).
 * The watchdog burrow-cancel rides the seam (`provider.cancel(handle)`), so the
 * test injects a provider whose `cancel` pushes the run's `providerRunId`.
 */
export function makeCancelProvider(cancels: string[]): RuntimeProvider {
	return {
		cancel: async (handle: RunHandle) => {
			cancels.push(handle.providerRunId);
		},
	} as unknown as RuntimeProvider;
}

/** A `RunStatus` with sane defaults, overridable per-field. */
export function statusOf(over: Partial<RunStatus>): RunStatus {
	return {
		phase: "running",
		exitCode: null,
		lastEventSeq: 0,
		lastEventTs: null,
		exists: true,
		...over,
	};
}

/** A provider whose `status()` returns `status` and records the probe count (warren-c433). */
export function makeStatusProvider(status: RunStatus): {
	provider: RuntimeProvider;
	statusCalls: () => number;
} {
	let calls = 0;
	const provider = {
		status: async (_handle: RunHandle): Promise<RunStatus> => {
			calls += 1;
			return status;
		},
		cancel: async () => {},
	} as unknown as RuntimeProvider;
	return { provider, statusCalls: () => calls };
}

/** Offset an ISO timestamp by `ms`. */
export function isoPlus(base: string, ms: number): string {
	return new Date(Date.parse(base) + ms).toISOString();
}

/** Seed the agent + project rows the watchdog suites hang runs off. */
export async function seedWatchdogFixtures(repos: Repos): Promise<void> {
	await repos.agents.upsert({ name: "claude-code", renderedJson: makeAgentJson() });
	await repos.projects.create({
		id: PROJECT_ID,
		gitUrl: "https://github.com/x/y.git",
		localPath: "/data/projects/x/y",
		defaultBranch: "main",
	});
}

/** Create a claude-code run and mark it `running` at `startedAt`. */
export async function seedRunningRun(repos: Repos, startedAt: string): Promise<string> {
	const row = await repos.runs.create({
		agentName: "claude-code",
		projectId: PROJECT_ID,
		prompt: "go",
		renderedAgentJson: makeAgentJson(),
		trigger: "manual",
		mode: "batch",
	});
	await repos.runs.markRunning(row.id, new Date(startedAt));
	return row.id;
}

/**
 * One Bash `tool_use` at `toolUseAt`, then `heartbeats` claude-code
 * `tool_progress` keep-alives 30 s apart, stored the way the claude-code
 * parser stores them (namphuongtran/warren#83). Returns the next free seq and
 * the newest heartbeat's ts.
 */
export async function seedHungToolCall(
	repos: Repos,
	runId: string,
	opts: { readonly toolUseAt: string; readonly toolUseId: string; readonly heartbeats: number },
): Promise<{ nextSeq: number; lastTs: string }> {
	await repos.events.append({
		runId,
		sandboxEventSeq: 1,
		ts: opts.toolUseAt,
		kind: "tool_use",
		stream: "stdout",
		payload: {
			type: "tool_use",
			id: opts.toolUseId,
			name: "Bash",
			input: { command: "uv run pytest -q", timeout: 3_600_000 },
		},
	});
	let lastTs = opts.toolUseAt;
	for (let i = 1; i <= opts.heartbeats; i++) {
		lastTs = isoPlus(opts.toolUseAt, i * 30_000);
		await repos.events.append({
			runId,
			sandboxEventSeq: 1 + i,
			ts: lastTs,
			kind: "text",
			stream: "stdout",
			payload: {
				type: "tool_progress",
				tool_use_id: opts.toolUseId,
				tool_name: "Bash",
				parent_tool_use_id: null,
				elapsed_time_seconds: i * 30,
				heartbeat: true,
			},
		});
	}
	return { nextSeq: opts.heartbeats + 2, lastTs };
}

/**
 * Tool-call stall warning for the run heartbeat watchdog
 * (namphuongtran/warren#83).
 *
 * The heartbeat budget force-fails a run that has been silent for 45 minutes.
 * That is a kill, so it stays generous. A hung tool call (a test suite
 * deadlocked on a database lock, say) deserves an earlier, softer signal: the
 * operator should see it is stuck long before the budget runs out. When one
 * tool call has stayed open past the stall threshold, the watchdog writes one
 * `watchdog.tool_stalled` event naming the tool, its command, and how long it
 * has been open. The run keeps running.
 *
 * The check is cheap on a healthy run. It reads the run's tool trace only when
 * no tool call has started for the threshold: one indexed lookup of the newest
 * `tool_use`. Results, text, and steering do not hold the warning off, so a
 * hung call still warns after a parallel sibling returns. A newer `tool_use`
 * does: an agent still starting calls (a subagent at work under an open
 * `Task`) is busy, not stalled. The heartbeat idle clock skips this module's
 * own warning, so the warning cannot delay the force-fail.
 */

import type { Repos } from "../db/repos/index.ts";
import type { RunRow } from "../db/schema.ts";
import type { WarrenConfigCache } from "../warren-config/index.ts";
import {
	extractToolResult,
	extractToolUse,
	runtimeFromRenderedAgent,
} from "./analytics/tool-call-extract.ts";
import type { RunEventBroker } from "./events.ts";
import { type BridgeLogger, bindBridgeLogger } from "./stream/index.ts";

/** Event kind the watchdog writes when one tool call stays open past the stall threshold. */
export const WATCHDOG_TOOL_STALLED_KIND = "watchdog.tool_stalled";

/**
 * Default stall threshold (ms): 15 minutes. A warning, not a kill, so it sits
 * well below the 45-minute heartbeat budget. Override with
 * `WARREN_TOOL_STALL_WARN_MS`, or per project with `toolStallWarnMinutes`.
 */
export const DEFAULT_TOOL_STALL_WARN_MS = 900_000;

const MS_PER_MINUTE = 60_000;

/** Longest command excerpt the warning carries. */
const COMMAND_EXCERPT_CHARS = 200;

export interface ToolStallDeps {
	readonly repos: Repos;
	/**
	 * Instance-wide stall threshold (ms). Absent or `0` turns the warning off,
	 * unless `resolveToolStallWarnMs` answers for the run.
	 */
	readonly toolStallWarnMs?: number;
	/**
	 * The run's project override (ms), read from `.warren/config.yaml`
	 * `toolStallWarnMinutes`. `undefined` falls back to `toolStallWarnMs`.
	 */
	readonly resolveToolStallWarnMs?: (run: RunRow) => Promise<number | undefined>;
	readonly broker?: RunEventBroker;
	readonly logger?: BridgeLogger;
}

/** One stall warning the tick wrote. */
export interface ToolStall {
	readonly runId: string;
	readonly toolUseId: string;
	readonly toolName: string | null;
	readonly elapsedMs: number;
}

interface OpenCall {
	readonly toolUseId: string;
	readonly toolName: string | null;
	readonly command: string | null;
	readonly openedAt: string;
}

/**
 * Write a `watchdog.tool_stalled` event when the run's newest open tool call
 * has been open past the threshold and has not been warned about yet.
 * Returns the warning it wrote, or `null`.
 */
export async function maybeWarnToolStall(
	deps: ToolStallDeps,
	run: RunRow,
	now: Date,
): Promise<ToolStall | null> {
	const thresholdMs = (await deps.resolveToolStallWarnMs?.(run)) ?? deps.toolStallWarnMs ?? 0;
	if (thresholdMs <= 0) return null;
	const newestUse = await deps.repos.events.newestTsOfKind(run.id, "tool_use");
	if (newestUse === null || now.getTime() - Date.parse(newestUse) < thresholdMs) return null;
	const call = await newestOpenCall(deps.repos, run);
	if (call === null) return null;
	const elapsedMs = now.getTime() - Date.parse(call.openedAt);
	if (!Number.isFinite(elapsedMs) || elapsedMs < thresholdMs) return null;
	if (await alreadyWarned(deps.repos, run.id, call.toolUseId)) return null;

	const seq = ((await deps.repos.events.maxSeqForRun(run.id)) ?? 0) + 1;
	const row = await deps.repos.events.append({
		runId: run.id,
		sandboxEventSeq: seq,
		ts: now.toISOString(),
		kind: WATCHDOG_TOOL_STALLED_KIND,
		stream: "system",
		payload: {
			toolUseId: call.toolUseId,
			toolName: call.toolName,
			command: call.command === null ? null : call.command.slice(0, COMMAND_EXCERPT_CHARS),
			elapsedMs,
			toolStallWarnMs: thresholdMs,
		},
	});
	deps.broker?.publish(run.id, row);
	bindBridgeLogger(deps.logger, { run_id: run.id }).warn(
		{ event: WATCHDOG_TOOL_STALLED_KIND, toolUseId: call.toolUseId, elapsedMs, thresholdMs },
		"watchdog: tool call open past the stall threshold",
	);
	return { runId: run.id, toolUseId: call.toolUseId, toolName: call.toolName, elapsedMs };
}

/**
 * The most recently opened tool call with no `tool_result` yet. Newest
 * rather than oldest because an outer call (a subagent's `Task`) stays open
 * while the inner call that is actually stuck runs. A `tool_use` whose id
 * cannot be read is skipped: no result could ever close it.
 */
async function newestOpenCall(repos: Repos, run: RunRow): Promise<OpenCall | null> {
	const runtime = runtimeFromRenderedAgent(run.renderedAgentJson);
	const open = new Map<string, OpenCall>();
	for (const event of await repos.events.listToolEventsForRun(run.id)) {
		if (event.kind === "tool_use") {
			const use = extractToolUse(runtime, event.payloadJson);
			if (use.toolUseId === null) continue;
			open.set(use.toolUseId, {
				toolUseId: use.toolUseId,
				toolName: use.toolName,
				command: use.command,
				openedAt: event.ts,
			});
		} else {
			const result = extractToolResult(runtime, event.payloadJson);
			if (result !== null) open.delete(result.toolUseId);
		}
	}
	// Map iteration follows insertion order, which follows seq order.
	return [...open.values()].at(-1) ?? null;
}

async function alreadyWarned(repos: Repos, runId: string, toolUseId: string): Promise<boolean> {
	const warnings = await repos.events.listEventsByKindsForRuns(
		[runId],
		[WATCHDOG_TOOL_STALLED_KIND],
	);
	return warnings.some(
		(w) => (w.payloadJson as { toolUseId?: unknown } | null)?.toolUseId === toolUseId,
	);
}

/**
 * Build the per-run project override: `toolStallWarnMinutes` from the run's
 * `.warren/config.yaml`, in ms. Answers `undefined` (use the instance default)
 * when the project row, its clone, or the key is missing; a config read error
 * must never silence or crash the watchdog.
 */
export function projectToolStallResolver(input: {
	readonly repos: Repos;
	readonly warrenConfigs: WarrenConfigCache;
}): (run: RunRow) => Promise<number | undefined> {
	return async (run) => {
		if (run.projectId === null) return undefined;
		try {
			const project = await input.repos.projects.get(run.projectId);
			if (project === null || project.localPath === null) return undefined;
			const loaded = await input.warrenConfigs.get(project.id, project.localPath);
			const minutes = loaded.defaults?.toolStallWarnMinutes;
			return minutes === undefined ? undefined : minutes * MS_PER_MINUTE;
		} catch {
			return undefined;
		}
	};
}

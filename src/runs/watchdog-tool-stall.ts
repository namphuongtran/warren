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
 *
 * A second, opt-in threshold kills (`WARREN_TOOL_STALL_KILL_MS`, project
 * `toolStallKillMinutes`; off by default): a call open past it force-fails
 * the run through the watchdog's reap path, so partial work is still pushed.
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

/** A run's project overrides (ms); an absent field falls back to the instance value. */
export interface ToolStallLimits {
	readonly warnMs?: number;
	readonly killMs?: number;
}

export interface ToolStallDeps {
	readonly repos: Repos;
	/**
	 * Instance-wide stall threshold (ms). Absent or `0` turns the warning off,
	 * unless `resolveToolStallLimits` answers for the run.
	 */
	readonly toolStallWarnMs?: number;
	/** Instance-wide kill threshold (ms). Absent or `0` (the default) never kills. */
	readonly toolStallKillMs?: number;
	/**
	 * The run's project overrides, read from `.warren/config.yaml`
	 * `toolStallWarnMinutes` and `toolStallKillMinutes`.
	 */
	readonly resolveToolStallLimits?: (run: RunRow) => Promise<ToolStallLimits>;
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

export interface OpenCall {
	readonly toolUseId: string;
	readonly toolName: string | null;
	readonly command: string | null;
	readonly openedAt: string;
}

/** A call open past the kill threshold: the watchdog force-fails the run. */
export interface ToolStallKill extends ToolStall {
	readonly toolStallKillMs: number;
}

/**
 * What the stall check decided for one run: `kill` (force-fail it), `warned`
 * (a `watchdog.tool_stalled` event was written), or `null` (nothing to do).
 */
export type ToolStallVerdict =
	| { readonly kind: "kill"; readonly stall: ToolStallKill }
	| { readonly kind: "warned"; readonly stall: ToolStall }
	| null;

/**
 * Check the run's newest open tool call against the kill threshold, then the
 * warning threshold. The kill wins when both are crossed. The kill itself is
 * the caller's: it owns the force-fail path.
 */
export async function checkToolStall(
	deps: ToolStallDeps,
	run: RunRow,
	now: Date,
): Promise<ToolStallVerdict> {
	const limits = (await deps.resolveToolStallLimits?.(run)) ?? {};
	const killMs = limits.killMs ?? deps.toolStallKillMs ?? 0;
	const kill = await openPast(deps.repos, run, now, killMs);
	if (kill !== null) {
		const stall = { runId: run.id, ...summarize(kill.call), elapsedMs: kill.elapsedMs };
		return { kind: "kill", stall: { ...stall, toolStallKillMs: killMs } };
	}
	const warned = await maybeWarnToolStall(deps, run, now, limits.warnMs ?? deps.toolStallWarnMs);
	return warned === null ? null : { kind: "warned", stall: warned };
}

/**
 * The run's newest open call when it has been open for `thresholdMs` or more.
 * Cheap below the threshold: the trace is read only once no `tool_use` has
 * started for that long.
 */
async function openPast(
	repos: Repos,
	run: RunRow,
	now: Date,
	thresholdMs: number,
): Promise<{ readonly call: OpenCall; readonly elapsedMs: number } | null> {
	if (thresholdMs <= 0) return null;
	const newestUse = await repos.events.newestTsOfKind(run.id, "tool_use");
	if (newestUse === null || now.getTime() - Date.parse(newestUse) < thresholdMs) return null;
	const call = await newestOpenCall(repos, run);
	if (call === null) return null;
	const elapsedMs = now.getTime() - Date.parse(call.openedAt);
	if (!Number.isFinite(elapsedMs) || elapsedMs < thresholdMs) return null;
	return { call, elapsedMs };
}

/** The `watchdog.timed_out` payload fields of a tool-stall kill. */
export function toolStallCause(stall: ToolStallKill) {
	const { toolUseId, toolName, elapsedMs, toolStallKillMs } = stall;
	return { cause: "tool_stall", toolUseId, toolName, toolElapsedMs: elapsedMs, toolStallKillMs };
}

function summarize(call: OpenCall): Pick<ToolStall, "toolUseId" | "toolName"> {
	return { toolUseId: call.toolUseId, toolName: call.toolName };
}

/**
 * Write a `watchdog.tool_stalled` event when the run's newest open tool call
 * has been open past the threshold and has not been warned about yet.
 * Returns the warning it wrote, or `null`.
 */
async function maybeWarnToolStall(
	deps: ToolStallDeps,
	run: RunRow,
	now: Date,
	thresholdMs = 0,
): Promise<ToolStall | null> {
	const open = await openPast(deps.repos, run, now, thresholdMs);
	if (open === null) return null;
	const { call, elapsedMs } = open;
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
	// Map iteration follows insertion order, which follows seq order.
	return [...(await openToolCalls(repos, run)).values()].at(-1) ?? null;
}

/** The run's tool calls with no `tool_result` yet, keyed by `toolUseId`, oldest first. */
export async function openToolCalls(repos: Repos, run: RunRow): Promise<Map<string, OpenCall>> {
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
	return open;
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
 * Build the per-run project overrides: `toolStallWarnMinutes` and
 * `toolStallKillMinutes` from the run's `.warren/config.yaml`, in ms. A field
 * is absent (use the instance value) when the project row, its clone, or the
 * key is missing; a config read error must never silence or crash the
 * watchdog.
 */
export function projectToolStallResolver(input: {
	readonly repos: Repos;
	readonly warrenConfigs: WarrenConfigCache;
}): (run: RunRow) => Promise<ToolStallLimits> {
	return async (run) => {
		if (run.projectId === null) return {};
		try {
			const project = await input.repos.projects.get(run.projectId);
			if (project === null || project.localPath === null) return {};
			const defaults = (await input.warrenConfigs.get(project.id, project.localPath)).defaults;
			const warn = defaults?.toolStallWarnMinutes;
			const kill = defaults?.toolStallKillMinutes;
			return {
				...(warn !== undefined ? { warnMs: warn * MS_PER_MINUTE } : {}),
				...(kill !== undefined ? { killMs: kill * MS_PER_MINUTE } : {}),
			};
		} catch {
			return {};
		}
	};
}

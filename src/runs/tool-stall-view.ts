/**
 * The stalled-run view (namphuongtran/warren#83): which running runs sit on
 * a tool call the watchdog warned about, for the runs list and run page.
 *
 * A run is stalled while the call named by its newest `watchdog.tool_stalled`
 * warning has no `tool_result`. The warning itself is the watchdog's
 * (`./watchdog-tool-stall.ts`); this module only reads. One batched query
 * finds the warnings across the page of runs. Only a run that has one pays
 * for a read of its tool trace, and a healthy page has none.
 */

import type { RunToolStallView } from "../core/wire.ts";
import type { Repos } from "../db/repos/index.ts";
import type { RunRow } from "../db/schema.ts";
import { openToolCalls, WATCHDOG_TOOL_STALLED_KIND } from "./watchdog-tool-stall.ts";

interface StallWarningPayload {
	readonly toolUseId?: unknown;
	readonly command?: unknown;
}

/** The runs among `runs` that are stalled now, keyed by run id. */
export async function currentToolStalls(
	repos: Repos,
	runs: readonly RunRow[],
): Promise<Map<string, RunToolStallView>> {
	const stalls = new Map<string, RunToolStallView>();
	const running = runs.filter((run) => run.state === "running");
	const warnings = await repos.events.listEventsByKindsForRuns(
		running.map((run) => run.id),
		[WATCHDOG_TOOL_STALLED_KIND],
	);
	// Ordered by (runId, kind, seq): the last row per run is its newest warning.
	const newest = new Map(warnings.map((w) => [w.runId, w]));
	for (const run of running) {
		const warning = newest.get(run.id);
		if (warning === undefined) continue;
		const payload = (warning.payloadJson ?? {}) as StallWarningPayload;
		if (typeof payload.toolUseId !== "string") continue;
		const call = (await openToolCalls(repos, run)).get(payload.toolUseId);
		if (call === undefined) continue;
		stalls.set(run.id, {
			toolUseId: call.toolUseId,
			toolName: call.toolName,
			command: typeof payload.command === "string" ? payload.command : null,
			openedAt: call.openedAt,
			warnedAt: warning.ts,
		});
	}
	return stalls;
}

/**
 * Keep the provider quota state current from the live event stream
 * (namphuongtran/warren#30).
 *
 * Every persisted event goes through the adapters' `observeQuota` hook; a
 * usage-window report (claude-code's `rate_limit_event`) is recorded against
 * the run's credential, so the next `spawnRun` on that credential sees the
 * window seconds after the provider reported it. The read goes through the
 * shared envelope provenance gate, so an agent cannot close a window by
 * printing a fake report.
 */

import type { EventRow } from "../../db/schema.ts";
import { observeQuota } from "../../runtime/adapters/index.ts";
import { recordQuotaObservation } from "../quota/state.ts";
import type { BridgeRunStreamInput } from "./types.ts";

/**
 * Record `row` when it reports the provider's usage window. Best-effort: a
 * failed write logs, because quota bookkeeping must never stop the event pump.
 */
export async function recordProviderQuota(
	input: BridgeRunStreamInput,
	row: EventRow,
): Promise<void> {
	const observation = observeQuota({
		kind: row.kind,
		stream: row.stream,
		...(row.origin !== null ? { origin: row.origin } : {}),
		payload: row.payloadJson,
	});
	if (observation === null) return;
	try {
		const run = await input.repos.runs.require(input.runId);
		await recordQuotaObservation(input.repos, {
			credential: { provider: run.provider, env: process.env },
			observation,
			source: "rate_limit_event",
			sourceRunId: input.runId,
			observedAt: row.ts,
		});
	} catch (err) {
		input.logger?.warn?.(
			{ runId: input.runId, err: err instanceof Error ? err.message : String(err) },
			"failed to record the provider's usage window; dispatch keeps the older state",
		);
	}
}

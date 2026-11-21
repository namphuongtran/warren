/**
 * Append one warren-authored `system` event to a run's log and fan it out
 * to live subscribers. The bridge's enforcement trips (spend cap, turn
 * monitor, wall-clock limit) all explain a cancel this way, so the
 * operator sees WHY the run was cut. Best-effort: a failure is logged and
 * swallowed so a trip never throws out of the bridge.
 */

import type { Repos } from "../../db/repos/index.ts";
import type { RunEventBroker } from "../events.ts";
import type { BridgeLogger } from "./types.ts";

export interface SystemEventInput {
	readonly runId: string;
	readonly kind: string;
	readonly payload: Record<string, unknown>;
	readonly repos: Repos;
	readonly broker: RunEventBroker;
	readonly logger?: BridgeLogger;
}

export async function appendSystemEvent(input: SystemEventInput): Promise<void> {
	try {
		const seq = ((await input.repos.events.maxSeqForRun(input.runId)) ?? 0) + 1;
		const row = await input.repos.events.append({
			runId: input.runId,
			sandboxEventSeq: seq,
			ts: new Date().toISOString(),
			kind: input.kind,
			stream: "system",
			payload: input.payload,
		});
		input.broker.publish(input.runId, row);
	} catch (err) {
		input.logger?.error?.(
			{ runId: input.runId, err: err instanceof Error ? err.message : String(err) },
			`failed to emit ${input.kind} event`,
		);
	}
}

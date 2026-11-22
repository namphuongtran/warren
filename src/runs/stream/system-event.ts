/**
 * Append one warren-authored `system` event to a run's log and fan it out
 * to live subscribers. The bridge's enforcement trips (spend cap, turn
 * monitor, wall-clock limit) all explain a cancel this way, so the
 * operator sees WHY the run was cut. Best-effort: a failure is logged and
 * swallowed so a trip never throws out of the bridge.
 */

import type { Repos } from "../../db/repos/index.ts";
import type { EventRow } from "../../db/schema.ts";
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

export interface RunSystemEvent {
	readonly runId: string;
	readonly kind: string;
	readonly payload: unknown;
	/** ISO8601. */
	readonly ts: string;
}

/**
 * Append one `system` event at the run's next seq and publish it when a
 * broker is wired. Throws on a failed write: the caller decides whether the
 * event is load-bearing (a decision record) or best-effort.
 */
export async function appendRunSystemEvent(
	repos: Pick<Repos, "events">,
	broker: Pick<RunEventBroker, "publish"> | undefined,
	event: RunSystemEvent,
): Promise<EventRow> {
	const seq = ((await repos.events.maxSeqForRun(event.runId)) ?? 0) + 1;
	const row = await repos.events.append({
		runId: event.runId,
		sandboxEventSeq: seq,
		ts: event.ts,
		kind: event.kind,
		stream: "system",
		payload: event.payload,
	});
	broker?.publish(event.runId, row);
	return row;
}

export async function appendSystemEvent(input: SystemEventInput): Promise<void> {
	try {
		const { runId, kind, payload } = input;
		await appendRunSystemEvent(input.repos, input.broker, {
			runId,
			kind,
			payload,
			ts: new Date().toISOString(),
		});
	} catch (err) {
		input.logger?.error?.(
			{ runId: input.runId, err: err instanceof Error ? err.message : String(err) },
			`failed to emit ${input.kind} event`,
		);
	}
}

/**
 * Reap step for the per-run quality-gate outcome (namphuongtran/warren#36).
 *
 * Reads the run's tool events, derives the outcome against the `qualityGate`
 * frozen at dispatch, stamps it on the run row, and emits
 * `quality.gate_outcome`. Warren never runs the gate: this only reads what
 * the agent did inside its sandbox.
 *
 * Best-effort bookkeeping, like the outcome facts: a failure is logged and
 * never thrown out of reap, and the row keeps NULL ("not derived").
 */

import type { Repos } from "../../db/repos/index.ts";
import type { EventRow, RunRow } from "../../db/schema.ts";
import { runtimeFromRenderedAgent } from "../analytics/tool-call-extract.ts";
import { deriveQualityGateOutcome } from "../quality-gate/outcome.ts";
import type { BoundBridgeLogger } from "../stream/index.ts";

/** The system event reap emits with the derived outcome. */
export const QUALITY_GATE_OUTCOME_KIND = "quality.gate_outcome";

export interface RecordQualityGateOutcomeInput {
	readonly repos: Repos;
	readonly run: RunRow;
	readonly emit: (kind: string, payload: unknown) => Promise<EventRow>;
	readonly log: BoundBridgeLogger;
}

/**
 * Derive, persist, and announce the run's gate outcome. The event payload
 * leaves the gate command out on purpose: the event stream reaches public
 * spectators, and the command is operator configuration.
 */
export async function recordQualityGateOutcome(
	input: RecordQualityGateOutcomeInput,
): Promise<void> {
	const { repos, run } = input;
	try {
		const events = await repos.events.listToolEventsForRun(run.id);
		const derivation = deriveQualityGateOutcome({
			gateCommand: run.qualityGate,
			runtime: runtimeFromRenderedAgent(run.renderedAgentJson),
			events: events.map((ev) => ({ kind: ev.kind, payload: ev.payloadJson })),
		});
		await repos.runs.setQualityGateOutcome(run.id, derivation.outcome);
		await input.emit(QUALITY_GATE_OUTCOME_KIND, derivation);
	} catch (err) {
		input.log.warn(
			{
				event: "reap.quality_gate_outcome_failed",
				runId: run.id,
				err: err instanceof Error ? err.message : String(err),
			},
			"quality-gate outcome could not be derived",
		);
	}
}

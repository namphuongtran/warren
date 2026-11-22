/**
 * Quality-gate outcome vocabulary (namphuongtran/warren#36), split out of
 * wire.ts under the file-size budget and re-exported from there so the
 * canonical home stays one module.
 *
 * Reap derives one outcome per run from the tool calls the agent made inside
 * its sandbox. Warren never runs the gate itself.
 *
 * - `unconfigured` — the project sets no `qualityGate`.
 * - `not_run` — a gate is configured, and the agent never invoked it.
 * - `passed` — the last gate invocation exited zero, with no file edit after it.
 * - `failed` — the last gate invocation exited non-zero.
 * - `stale` — the last invocation passed, then the agent edited files.
 * - `unknown` — the agent invoked the gate, but its exit status cannot be
 *   read: the command masked it (`gate; echo done`, `gate | tail`) without
 *   printing an exit marker, or no tool result was recorded.
 */
export const RUN_QUALITY_GATE_OUTCOMES = [
	"unconfigured",
	"not_run",
	"passed",
	"failed",
	"stale",
	"unknown",
] as const;
export type RunQualityGateOutcome = (typeof RUN_QUALITY_GATE_OUTCOMES)[number];

/** Membership predicate for {@link RUN_QUALITY_GATE_OUTCOMES}. */
export function isRunQualityGateOutcome(value: unknown): value is RunQualityGateOutcome {
	return (
		typeof value === "string" && (RUN_QUALITY_GATE_OUTCOMES as readonly string[]).includes(value)
	);
}

/**
 * Why an `unknown` outcome could not read the gate's exit status, carried on
 * the `quality.gate_outcome` event: `exit_status_masked` when the command hid
 * it and printed no `exit=N` marker, `no_result` when no tool result was
 * recorded for the gate call.
 */
export const RUN_QUALITY_GATE_UNKNOWN_REASONS = ["exit_status_masked", "no_result"] as const;
export type RunQualityGateUnknownReason = (typeof RUN_QUALITY_GATE_UNKNOWN_REASONS)[number];

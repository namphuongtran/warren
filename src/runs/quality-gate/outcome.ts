/**
 * Per-run quality-gate outcome (namphuongtran/warren#36).
 *
 * `qualityGate` reaches the agent as `$WARREN_QUALITY_GATE`, and the prompt
 * calls the gate terminal, but until this module Warren recorded nothing
 * about whether the agent ran it. This derivation reads what the agent did
 * inside its sandbox: the run's `tool_use` / `tool_result` events. Warren
 * never runs the gate itself.
 *
 * The per-harness payload parse stays behind the runtime seams: the tool
 * shape (`src/core/tool-shape.ts`) reads the command, join id, error flag,
 * and result text, and the adapter declares which tools edit files. This
 * module only compares commands and ordering.
 */

import { toolShapeFor } from "../../core/tool-shape.ts";
import type {
	RunQualityGateOutcome,
	RunQualityGateUnknownReason,
	RuntimeId,
} from "../../core/wire.ts";
import { adapterFor } from "../../runtime/adapters/index.ts";
import {
	findGateInvocation,
	type GateInvocation,
	masksExitStatus,
	readExitMarker,
} from "./command.ts";

/** One persisted tool event. Callers pass the run's events in sequence order. */
export interface GateToolEvent {
	readonly kind: string;
	readonly payload: unknown;
}

export interface DeriveQualityGateInput {
	/** The `qualityGate` frozen on the run at dispatch; null = unconfigured. */
	readonly gateCommand: string | null;
	readonly runtime: RuntimeId;
	readonly events: readonly GateToolEvent[];
}

export interface QualityGateDerivation {
	readonly outcome: RunQualityGateOutcome;
	/** Successful file edits after the last gate call; 0 when it never ran. */
	readonly editsAfterGate: number;
	/** Why an `unknown` outcome could not read the exit status. */
	readonly unknownReason?: RunQualityGateUnknownReason;
}

interface ToolUse {
	readonly toolName: string | null;
	readonly command: string | null;
	readonly toolUseId: string | null;
}

interface ToolResult {
	readonly isError: boolean;
	readonly text: string | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

/** Read the run's tool uses (in order) and results (by join id) through the runtime's shape. */
function readToolTrace(
	runtime: RuntimeId,
	events: readonly GateToolEvent[],
): { uses: ToolUse[]; results: Map<string, ToolResult> } {
	const shape = toolShapeFor(runtime);
	const uses: ToolUse[] = [];
	const results = new Map<string, ToolResult>();
	if (shape === null) return { uses, results };
	for (const event of events) {
		const record = asRecord(event.payload);
		if (record === null) continue;
		if (event.kind === "tool_use") {
			const use = shape.readToolUse(record);
			if (use !== null) uses.push(use);
		} else if (event.kind === "tool_result") {
			const result = shape.readToolResult(record);
			if (result?.toolUseId) {
				results.set(result.toolUseId, {
					isError: result.isError,
					text: shape.readResultText(record),
				});
			}
		}
	}
	return { uses, results };
}

/** The last tool call that invoked the gate, with where the invocation sits in its command. */
function findLastGateCall(
	uses: readonly ToolUse[],
	gate: string,
): { index: number; use: ToolUse; invocation: GateInvocation } | null {
	for (let index = uses.length - 1; index >= 0; index--) {
		const use = uses[index];
		const invocation = use?.command != null ? findGateInvocation(use.command, gate) : null;
		if (use !== undefined && invocation !== null) return { index, use, invocation };
	}
	return null;
}

/** Derive the run's gate outcome from its tool events. Pure; never throws. */
export function deriveQualityGateOutcome(input: DeriveQualityGateInput): QualityGateDerivation {
	const gate = input.gateCommand;
	if (gate === null) return { outcome: "unconfigured", editsAfterGate: 0 };
	const { uses, results } = readToolTrace(input.runtime, input.events);
	const editTools = new Set(adapterFor(input.runtime).fileEditToolNames ?? []);
	const resultOf = (use: ToolUse): ToolResult | undefined =>
		use.toolUseId === null ? undefined : results.get(use.toolUseId);

	const last = findLastGateCall(uses, gate);
	if (last === null) return { outcome: "not_run", editsAfterGate: 0 };
	const { index: lastGateIndex, use: gateUse, invocation } = last;
	const editsAfterGate = uses
		.slice(lastGateIndex + 1)
		.filter((use) => use.toolName !== null && editTools.has(use.toolName))
		.filter((use) => resultOf(use)?.isError !== true).length;
	const gateResult = resultOf(gateUse);
	if (gateResult === undefined) {
		return { outcome: "unknown", editsAfterGate, unknownReason: "no_result" };
	}
	if (gateResult.isError) return { outcome: "failed", editsAfterGate };
	if (masksExitStatus(invocation)) {
		const status = readExitMarker(gateResult.text ?? "");
		if (status === null) {
			return { outcome: "unknown", editsAfterGate, unknownReason: "exit_status_masked" };
		}
		if (status !== 0) return { outcome: "failed", editsAfterGate };
	}
	return { outcome: editsAfterGate > 0 ? "stale" : "passed", editsAfterGate };
}

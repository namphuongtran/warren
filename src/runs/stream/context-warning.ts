/**
 * Context-window warning for the event bridge (namphuongtran/warren#20).
 *
 * A long run can fill its model's context window and degrade or lose its work
 * mid-report. The budget warning (`./budget-warning.ts`, #9) is the spend
 * analogue; this module is the same shape for context. Each persisted event
 * goes through the adapters' `observeContext` hook. Once the conversation
 * holds a fraction of the window (default 80%,
 * `WARREN_CONTEXT_WARNING_FRACTION`, `0` turns it off), the bridge emits one
 * `context.warning` system event. When the harness consumes steering mid-run
 * (`frontmatter.steering: "mid-run"`), it also sends one wrap-up steer through
 * `steerRun`, so the steer gets the capability gate and the `steer.sent`
 * audit event. Spawn-only harnesses (claude-code) get the event only.
 *
 * The warning fires once per run. Context use can fall (pi compacts), so a
 * resumed bridge does not replay readings: it latches when the run already
 * carries a `context.warning` row. The window size comes from the adapter,
 * never from a table here.
 */

import { RUN_HANDOFF_PATH, type SteeringCapability } from "../../core/wire.ts";
import { type ContextObservation, observeContext } from "../../runtime/adapters/index.ts";
import { type SteerRunFn, warningFractionFromEnv } from "./budget-warning.ts";
import { readObservedModel } from "./observed-model.ts";
import { appendSystemEvent } from "./system-event.ts";
import type { BridgeLogger, BridgeRunStreamInput, StreamEventView } from "./types.ts";

export const CONTEXT_WARNING_EVENT = "context.warning";
export const CONTEXT_WARNING_FRACTION_ENV = "WARREN_CONTEXT_WARNING_FRACTION";

/** The context warning's fraction: unset → 0.8, `0` → off, malformed → 0.8 with a log line. */
export function contextWarningFractionFromEnv(
	env: Readonly<Record<string, string | undefined>>,
	logger?: BridgeLogger,
): number | null {
	return warningFractionFromEnv(env, CONTEXT_WARNING_FRACTION_ENV, logger);
}

/** Tokens at which the warning fires for a window. */
function contextWarningThresholdTokens(windowTokens: number, fraction: number): number {
	return Math.round(windowTokens * fraction);
}

/** The steering message a mid-run harness receives at the warning. */
function contextWarningSteerBody(observation: ContextObservation): string {
	const percent = Math.round((observation.tokensUsed * 100) / observation.windowTokens);
	const used = observation.tokensUsed.toLocaleString("en-US");
	const windowTokens = observation.windowTokens.toLocaleString("en-US");
	return (
		`Your context window is ${percent}% full (${used} of ${windowTokens} tokens). ` +
		`Write ${RUN_HANDOFF_PATH} and your report now, then continue or stop.`
	);
}

/** The bridge's per-event surface. */
export interface BridgeContextWatch {
	/** Read one persisted event; raise the warning the first time the threshold is reached. */
	observe(event: StreamEventView): Promise<void>;
}

const INERT: BridgeContextWatch = { observe: async () => {} };

/**
 * Build the watch for one bridge pass. Returns an inert watch when the
 * warning is off, or when the run row cannot be read: a DB hiccup never
 * blocks streaming. Only `steering: "mid-run"` gets the steer, the same rule
 * as the budget warning.
 */
export async function bridgeContextWatch(
	input: Pick<BridgeRunStreamInput, "runId" | "repos" | "broker" | "logger">,
	steering: SteeringCapability | undefined,
	steer: SteerRunFn,
): Promise<BridgeContextWatch> {
	const fraction = contextWarningFractionFromEnv(process.env, input.logger);
	if (fraction === null) return INERT;
	let runModel: string | null;
	let fired: boolean;
	try {
		runModel = (await input.repos.runs.require(input.runId)).model;
		fired = await input.repos.events.hasKind(input.runId, CONTEXT_WARNING_EVENT, "system");
	} catch (err) {
		input.logger?.warn?.(
			{ runId: input.runId, err: err instanceof Error ? err.message : String(err) },
			"failed to resolve the context-warning state; proceeding without the warning",
		);
		return INERT;
	}
	return {
		observe: async (event) => {
			if (fired) return;
			runModel = readObservedModel(event) ?? runModel;
			const observation = observeContext(event, runModel);
			if (observation === null) return;
			const thresholdTokens = contextWarningThresholdTokens(observation.windowTokens, fraction);
			if (observation.tokensUsed < thresholdTokens) return;
			fired = true;
			await raiseContextWarning(input, { ...observation, thresholdTokens, fraction });
			if (steering === "mid-run") await steerAtContextWarning(input, steer, observation);
		},
	};
}

/** Emit the one `context.warning` row through the shared system-event emitter. */
async function raiseContextWarning(
	input: Pick<BridgeRunStreamInput, "runId" | "repos" | "broker" | "logger">,
	payload: ContextObservation & { readonly thresholdTokens: number; readonly fraction: number },
): Promise<void> {
	await appendSystemEvent({
		runId: input.runId,
		kind: CONTEXT_WARNING_EVENT,
		payload: { ...payload },
		repos: input.repos,
		broker: input.broker,
		...(input.logger !== undefined ? { logger: input.logger } : {}),
	});
}

/** Send the wrap-up steer. Best-effort: a failed steer logs, the run continues. */
async function steerAtContextWarning(
	input: Pick<BridgeRunStreamInput, "runId" | "logger">,
	steer: SteerRunFn,
	observation: ContextObservation,
): Promise<void> {
	try {
		await steer(contextWarningSteerBody(observation));
	} catch (err) {
		input.logger?.error?.(
			{ runId: input.runId, err: err instanceof Error ? err.message : String(err) },
			"context-warning steer failed; the run continues unwarned",
		);
	}
}

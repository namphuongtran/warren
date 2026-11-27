/**
 * Context-window watch for the event bridge (namphuongtran/warren#20).
 *
 * A long run can fill its model's context window and degrade or lose its work
 * mid-report. The budget warning (`./budget-warning.ts`, #9) is the spend
 * analogue; this module is the same shape for context. Each event goes through
 * the adapters' `observeContext` hook. Every reading is recorded as the run's
 * newest one in `run_context`, which the run detail's Spend panel reads. Once
 * the conversation holds a fraction of the window (default 80%,
 * `WARREN_CONTEXT_WARNING_FRACTION`, `0` turns the warning off), the bridge
 * emits one `context.warning` system event. When the harness consumes steering
 * mid-run (`frontmatter.steering: "mid-run"`), it also sends one wrap-up steer
 * through `steerRun`, so the steer gets the capability gate and the
 * `steer.sent` audit event. A spawn-only harness gets the event
 * only.
 *
 * A reading is not an event of its own. claude-code's parser emits one
 * `assistant_usage` event per API request just to carry it; the bridge hands
 * that event to {@link BridgeContextWatch.takeContextOnly} and drops it, so the
 * transcript and the events feed never fill with usage rows. pi's reading rides
 * its `turn_end`, which is persisted for its own sake and read after append.
 *
 * The warning fires once per run. Context use can fall (pi compacts), so a
 * resumed bridge does not replay readings: it latches when the run already
 * carries a `context.warning` row. The window size comes from the adapter,
 * never from a table here.
 */

import { RUN_HANDOFF_PATH, type SteeringCapability } from "../../core/wire.ts";
import {
	type ContextObservation,
	isContextOnlyEvent,
	observeContext,
} from "../../runtime/adapters/index.ts";
import { type SteerRunFn, warningFractionFromEnv } from "./budget-warning.ts";
import { readObservedModel } from "./observed-model.ts";
import { appendSystemEvent } from "./system-event.ts";
import type { BridgeLogger, BridgeRunStreamInput, StreamEventView } from "./types.ts";

export const CONTEXT_WARNING_EVENT = "context.warning";
export const CONTEXT_WARNING_FRACTION_ENV = "WARREN_CONTEXT_WARNING_FRACTION";

type WatchInput = Pick<BridgeRunStreamInput, "runId" | "repos" | "broker" | "logger">;

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
	/** Read one persisted event: record its reading and warn the first time the threshold is reached. */
	observe(event: StreamEventView): Promise<void>;
	/**
	 * Read `event` when it exists only to carry a reading, and return true so the
	 * bridge drops it unpersisted. Returns false for every other event.
	 */
	takeContextOnly(event: StreamEventView): Promise<boolean>;
}

/**
 * Build the watch for one bridge pass. Readings are always recorded. The
 * warning is off when the fraction is `0`, when the run already warned, or
 * when the run row cannot be read: a DB hiccup never blocks streaming. Only
 * `steering: "mid-run"` gets the steer, the same rule as the budget warning.
 */
export async function bridgeContextWatch(
	input: WatchInput,
	steering: SteeringCapability | undefined,
	steer: SteerRunFn,
): Promise<BridgeContextWatch> {
	const fraction = contextWarningFractionFromEnv(process.env, input.logger);
	const state = await resolveWatchState(input, fraction !== null);
	const record = newReadingRecorder(input);

	const observe = async (event: StreamEventView): Promise<void> => {
		state.runModel = readObservedModel(event) ?? state.runModel;
		const observation = observeContext(event, state.runModel);
		if (observation === null) return;
		await record(observation, event.ts);
		if (state.fired || fraction === null) return;
		const thresholdTokens = contextWarningThresholdTokens(observation.windowTokens, fraction);
		if (observation.tokensUsed < thresholdTokens) return;
		state.fired = true;
		await raiseContextWarning(input, { ...observation, thresholdTokens, fraction });
		if (steering === "mid-run") await steerAtContextWarning(input, steer, observation);
	};

	return {
		observe,
		takeContextOnly: async (event) => {
			if (!isContextOnlyEvent(event)) return false;
			await observe(event);
			return true;
		},
	};
}

/**
 * The run's model and whether it already warned. A read failure logs and
 * turns the warning off for this pass; readings are still recorded.
 */
async function resolveWatchState(
	input: WatchInput,
	warningOn: boolean,
): Promise<{ runModel: string | null; fired: boolean }> {
	try {
		const runModel = (await input.repos.runs.require(input.runId)).model;
		const fired =
			!warningOn ||
			(await input.repos.events.hasKind(input.runId, CONTEXT_WARNING_EVENT, "system"));
		return { runModel, fired };
	} catch (err) {
		input.logger?.warn?.(
			{ runId: input.runId, err: err instanceof Error ? err.message : String(err) },
			"failed to resolve the context-warning state; proceeding without the warning",
		);
		return { runModel: null, fired: true };
	}
}

/**
 * Record each reading as the run's newest. Best-effort: a failed write logs
 * and streaming continues. claude-code repeats one request's usage on every
 * content-block line, so a reading equal to the last one is not written again.
 */
function newReadingRecorder(
	input: WatchInput,
): (observation: ContextObservation, ts: Date | string) => Promise<void> {
	let last: string | null = null;
	return async (observation, ts) => {
		const key = `${observation.tokensUsed}/${observation.windowTokens}/${observation.model}`;
		if (key === last) return;
		try {
			await input.repos.runContext.record({
				runId: input.runId,
				tokensUsed: observation.tokensUsed,
				windowTokens: observation.windowTokens,
				model: observation.model,
				observedAt: ts instanceof Date ? ts.toISOString() : ts,
			});
			last = key;
		} catch (err) {
			input.logger?.warn?.(
				{ runId: input.runId, err: err instanceof Error ? err.message : String(err) },
				"failed to record the context-window reading; the run continues",
			);
		}
	};
}

/** Emit the one `context.warning` row through the shared system-event emitter. */
async function raiseContextWarning(
	input: WatchInput,
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

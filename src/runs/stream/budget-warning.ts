/**
 * Soft spend-cap warning for the event bridge (namphuongtran/warren#9).
 *
 * The hard cap (`./budget.ts`, warren-a63d) cancels a run the moment its
 * cumulative cost crosses `maxCostUsd`, even mid-way through the final
 * report. This module carries the policy for an earlier, non-fatal signal:
 * once observed cost crosses a fraction of the cap (default 80%,
 * `WARREN_BUDGET_WARNING_FRACTION`), the bridge emits one `budget.warning`
 * system event and, when the harness consumes steering mid-run
 * (`frontmatter.steering: "mid-run"`), sends the agent one steering message
 * asking it to wrap up. Spawn-only harnesses (claude-code) get the event only.
 *
 * Emission lives beside the hard-cap emission in `./budget.ts`; this file
 * holds the pure config, the threshold math, and the run-row resolution.
 */

import type { SteeringCapability } from "../../core/wire.ts";
import type { Repos } from "../../db/repos/index.ts";
import type { RuntimeProvider } from "../../runtime/contract.ts";
import { resolveCostCapUsd } from "../cost-cap.ts";
import type { RunEventBroker } from "../events.ts";
import { steeringCapabilityOf, steerRun } from "../steer.ts";
import type { BridgeLogger } from "./types.ts";

export const BUDGET_WARNING_FRACTION_ENV = "WARREN_BUDGET_WARNING_FRACTION";
export const DEFAULT_BUDGET_WARNING_FRACTION = 0.8;

/** Steering seam the bridge plugs with `steerRun` (tests inject a stub). */
export type SteerRunFn = (body: string) => Promise<void>;

/**
 * Per-bridge warning state. `fired` is the once-only latch; `steer` is null
 * when the harness cannot consume a mid-run steer, so the warning stays an
 * event only.
 */
export interface BudgetWarning {
	readonly fraction: number;
	readonly steer: SteerRunFn | null;
	fired: boolean;
}

/**
 * Resolve the warning fraction from env: unset → 0.8, `0` disables the
 * warning (null), a value in (0, 1) is used as-is. Anything else logs and
 * falls back to 0.8: a typo in an advisory knob must never break the bridge
 * and, with it, hard-cap enforcement (the cost-cap fail-open rule).
 */
export function budgetWarningFractionFromEnv(
	env: Readonly<Record<string, string | undefined>>,
	logger?: BridgeLogger,
): number | null {
	const raw = env[BUDGET_WARNING_FRACTION_ENV];
	if (raw === undefined || raw.trim() === "") return DEFAULT_BUDGET_WARNING_FRACTION;
	const parsed = Number(raw.trim());
	if (parsed === 0) return null;
	if (Number.isFinite(parsed) && parsed > 0 && parsed < 1) return parsed;
	logger?.warn?.(
		{ [BUDGET_WARNING_FRACTION_ENV]: raw },
		"budget warning fraction must be 0 (off) or between 0 and 1; using the 0.8 default",
	);
	return DEFAULT_BUDGET_WARNING_FRACTION;
}

/** USD cost at which the warning fires. */
export function budgetWarningThresholdUsd(capUsd: number, fraction: number): number {
	return capUsd * fraction;
}

/** True when observed cost has reached the warning threshold of a set cap. */
export function isNearBudget(costUsd: number, capUsd: number | null, fraction: number): boolean {
	if (capUsd === null) return false;
	return costUsd >= budgetWarningThresholdUsd(capUsd, fraction);
}

/**
 * Production steer seam: `steerRun` re-checks the run state and steering
 * capability, sends through the provider inbox, and records `steer.sent`.
 */
export function warningSteer(input: {
	readonly runId: string;
	readonly repos: Repos;
	readonly broker: RunEventBroker;
	readonly provider: RuntimeProvider;
}): SteerRunFn {
	return async (body) => {
		await steerRun({
			runId: input.runId,
			body,
			priority: "high",
			fromActor: "warren",
			repos: input.repos,
			broker: input.broker,
			runtimeProvider: input.provider,
		});
	};
}

/** The steering message a mid-run harness receives at the warning. */
export function budgetWarningSteerBody(costUsd: number, capUsd: number): string {
	return (
		`You are near the spend cap ($${costUsd.toFixed(2)} of $${capUsd.toFixed(2)} spent). ` +
		"Finish, commit, and write your final message now."
	);
}

/**
 * Build the bridge's warning state. Returns null when the run has no cap or
 * the warning is disabled. Only `steering: "mid-run"` gets the steer: unlike
 * `steerRun`'s fail-open read, an undeclared capability is not steered,
 * because an unsolicited steer nobody reads is worse than none. A resumed bridge whose seeded cost already sits
 * past the threshold starts latched: the prior pass crossed it and warned.
 */
export function newBudgetWarning(input: {
	readonly capUsd: number | null;
	readonly fraction: number | null;
	readonly steering: SteeringCapability | undefined;
	readonly steer: SteerRunFn;
	readonly seededCostUsd: number;
}): BudgetWarning | null {
	if (input.capUsd === null || input.fraction === null) return null;
	return {
		fraction: input.fraction,
		steer: input.steering === "mid-run" ? input.steer : null,
		fired: isNearBudget(input.seededCostUsd, input.capUsd, input.fraction),
	};
}

export interface BridgeBudgetPolicy {
	readonly costCapUsd: number | null;
	readonly steering: SteeringCapability | undefined;
}

/**
 * Resolve the run's spend cap (warren-a63d) and steering capability
 * (warren-3305) from its frozen `runs.rendered_agent_json`. Best-effort: a
 * missing row or read error resolves to no cap and no steering so a DB
 * hiccup never blocks streaming.
 */
export async function resolveBridgeBudgetPolicy(
	repos: Repos,
	runId: string,
	logger: BridgeLogger | undefined,
): Promise<BridgeBudgetPolicy> {
	let rendered: unknown;
	try {
		rendered = (await repos.runs.require(runId)).renderedAgentJson;
	} catch (err) {
		logger?.warn?.(
			{ runId, err: err instanceof Error ? err.message : String(err) },
			"failed to resolve spend cap; proceeding without enforcement",
		);
		return { costCapUsd: null, steering: undefined };
	}
	let steering: SteeringCapability | undefined;
	try {
		steering = steeringCapabilityOf(rendered);
	} catch {
		// A malformed `steering` value fails closed for the warning steer.
		steering = undefined;
	}
	return { costCapUsd: resolveCostCapUsd(rendered), steering };
}

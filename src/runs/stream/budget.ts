/**
 * Mid-run spend-cap enforcement for the event bridge (warren-a63d).
 *
 * The bridge accumulates pi's cumulative `turn_end` cost as events flow
 * through. When that cost crosses the run's resolved cap
 * (`resolveCostCapUsd` over `runs.rendered_agent_json` — the per-trigger
 * override already folded over the per-agent value), `enforceBudgetCap`:
 *
 *   1. persists the observed usage so `runs.cost_usd` reflects the spend
 *      that tripped the cap (the bridge would otherwise only checkpoint
 *      on the terminal envelope, which never arrives once we cancel),
 *   2. emits a `budget.exceeded` system event onto the run's log so the
 *      operator sees WHY the run was cut, and
 *   3. requests a graceful burrow cancel via the injected seam.
 *
 * It returns `true` to signal the caller to break the stream with a
 * `cancelled` terminal outcome; reap finalizes the warren row from there.
 *
 * Below the cap, the same call raises the soft warning
 * (namphuongtran/warren#9, policy in `./budget-warning.ts`): once cost
 * reaches the warning fraction it emits one `budget.warning` event and,
 * for a mid-run-steerable harness, sends one wrap-up steering message.
 *
 * All steps are best-effort — a persist / event / cancel failure is
 * logged and swallowed so enforcement never throws out of the bridge.
 */

import type { Repos } from "../../db/repos/index.ts";
import { isOverBudget } from "../cost-cap.ts";
import type { RunEventBroker } from "../events.ts";
import type { SessionStatsAccumulator } from "../usage-aggregate.ts";
import {
	type BudgetWarning,
	budgetWarningSteerBody,
	budgetWarningThresholdUsd,
	isNearBudget,
} from "./budget-warning.ts";
import { persistInStreamUsage } from "./stats.ts";
import type { BridgeLogger } from "./types.ts";

/** Graceful-cancel seam the bridge plugs with its burrow client. */
export type CancelBurrowRunFn = (reason: string) => Promise<void>;

export interface EnforceBudgetCapInput {
	readonly runId: string;
	readonly sandboxRunId: string;
	readonly costCapUsd: number | null;
	/** Pi accumulator (preferred when it has observed real usage). */
	readonly piUsage: SessionStatsAccumulator;
	/** Claude accumulator (fallback when no pi `turn_end` fired). */
	readonly claudeUsage: SessionStatsAccumulator;
	readonly repos: Repos;
	readonly broker: RunEventBroker;
	readonly cancelBurrowRun: CancelBurrowRunFn;
	/** Soft-warning latch (namphuongtran/warren#9); absent/null disables it. */
	readonly warning?: BudgetWarning | null;
	readonly logger?: BridgeLogger;
}

/**
 * Evaluate the run's cumulative cost against its cap. Returns `true` when
 * the cap was exceeded (caller should break with `cancelled`), `false`
 * otherwise. Reads pi cost when observed, else claude cost.
 */
export async function enforceBudgetCap(input: EnforceBudgetCapInput): Promise<boolean> {
	const costUsd = observedCostUsd(input.piUsage, input.claudeUsage);
	if (!isOverBudget(costUsd, input.costCapUsd)) {
		await warnIfNearBudget(input, costUsd);
		return false;
	}

	const capUsd = input.costCapUsd as number;
	input.logger?.warn?.(
		{ runId: input.runId, sandboxRunId: input.sandboxRunId, observedCostUsd: costUsd, capUsd },
		"run exceeded spend cap; cancelling",
	);

	// Persist the spend that tripped the cap so cost_usd isn't left null.
	await persistObservedUsage(input);

	await emitBudgetEvent(input, "budget.exceeded", { costUsd, capUsd });

	try {
		await input.cancelBurrowRun(`spend cap exceeded: $${costUsd} > $${capUsd}`);
	} catch (err) {
		input.logger?.error?.(
			{
				runId: input.runId,
				sandboxRunId: input.sandboxRunId,
				err: err instanceof Error ? err.message : String(err),
			},
			"budget-cap burrow cancel failed; reap will finalize from terminal-detect",
		);
	}
	return true;
}

/** Cumulative run cost with the bridge's pi-wins tiebreak (pi when observed, else claude). */
export function observedCostUsd(
	piUsage: SessionStatsAccumulator,
	claudeUsage: SessionStatsAccumulator,
): number {
	return piUsage.seen ? piUsage.costUsd : claudeUsage.costUsd;
}

/**
 * Persist observed usage with the bridge's pi-wins tiebreak: pi when a
 * `turn_end` was observed, else claude-code. No-op when neither was seen.
 */
export async function persistObservedUsage(
	input: Pick<
		EnforceBudgetCapInput,
		"runId" | "sandboxRunId" | "piUsage" | "claudeUsage" | "repos" | "logger"
	>,
): Promise<void> {
	const usePi = input.piUsage.seen;
	await persistInStreamUsage({
		usage: usePi ? input.piUsage : input.claudeUsage,
		runtime: usePi ? "pi" : "claude-code",
		runId: input.runId,
		sandboxRunId: input.sandboxRunId,
		repos: input.repos,
		...(input.logger !== undefined ? { logger: input.logger } : {}),
	});
}

/**
 * Raise the soft warning once (namphuongtran/warren#9): latch, emit
 * `budget.warning`, then steer when the harness reads steering mid-run.
 */
async function warnIfNearBudget(
	input: EnforceBudgetCapInput,
	observedCostUsd: number,
): Promise<void> {
	const warning = input.warning;
	if (warning === undefined || warning === null || warning.fired) return;
	if (!isNearBudget(observedCostUsd, input.costCapUsd, warning.fraction)) return;
	warning.fired = true;
	const capUsd = input.costCapUsd as number;
	await emitBudgetEvent(input, "budget.warning", {
		costUsd: observedCostUsd,
		capUsd,
		thresholdUsd: budgetWarningThresholdUsd(capUsd, warning.fraction),
		fraction: warning.fraction,
	});
	if (warning.steer === null) return;
	try {
		await warning.steer(budgetWarningSteerBody(observedCostUsd, capUsd));
	} catch (err) {
		input.logger?.error?.(
			{ runId: input.runId, err: err instanceof Error ? err.message : String(err) },
			"budget-warning steer failed; the hard cap still applies",
		);
	}
}

async function emitBudgetEvent(
	input: EnforceBudgetCapInput,
	kind: "budget.exceeded" | "budget.warning",
	payload: Record<string, number>,
): Promise<void> {
	try {
		const seq = ((await input.repos.events.maxSeqForRun(input.runId)) ?? 0) + 1;
		const row = await input.repos.events.append({
			runId: input.runId,
			sandboxEventSeq: seq,
			ts: new Date().toISOString(),
			kind,
			stream: "system",
			payload,
		});
		input.broker.publish(input.runId, row);
	} catch (err) {
		input.logger?.error?.(
			{ runId: input.runId, err: err instanceof Error ? err.message : String(err) },
			`failed to emit ${kind} event`,
		);
	}
}

/**
 * Reap-time usage-limit detection (namphuongtran/warren#74).
 *
 * A run the provider refused because the account's usage window is spent used
 * to reap `crashed`: the harness prints the limit message as an assistant line,
 * so `inferFailureReason` saw a model turn. The recognizers live behind the
 * adapter seam (`detectQuotaExhausted` in `src/runtime/adapters/`); this module
 * reads the run's event log into them and shapes the `reap.quota_exhausted`
 * event. Reap then fails the run with `quota_exhausted` in place of
 * `crashed`, `no_model_response` or `provider_error`. A delivery reason
 * (`dropped_commit`, `finalize_failed`, `handoff_missing`, ...) or a watchdog
 * reason (`timed_out`, `duration_exceeded`) still names the run.
 */

import type { Repos } from "../../db/repos/index.ts";
import { detectQuotaExhausted, type QuotaExhaustedSignal } from "../../runtime/adapters/index.ts";

/** The system event reap emits when the provider refused the run on quota. */
export const REAP_QUOTA_EXHAUSTED_KIND = "reap.quota_exhausted";

/** Scan a run's persisted events for a usage-limit ending. */
export async function detectRunQuotaExhausted(
	repos: Repos,
	runId: string,
): Promise<QuotaExhaustedSignal | null> {
	const events = await repos.events.listByRun(runId);
	return detectQuotaExhausted(
		events.map((e) => ({
			kind: e.kind,
			stream: e.stream,
			...(e.origin !== null ? { origin: e.origin } : {}),
			payload: e.payloadJson,
		})),
	);
}

/**
 * Emit `reap.quota_exhausted`. The provider and model come from the run row;
 * nothing here reads or carries the credential.
 */
export async function recordQuotaExhausted(
	emit: (kind: string, payload: unknown) => Promise<unknown>,
	signal: QuotaExhaustedSignal,
	run: { readonly provider: string | null; readonly model: string | null },
): Promise<void> {
	await emit(REAP_QUOTA_EXHAUSTED_KIND, {
		provider: run.provider,
		model: run.model,
		httpStatus: signal.httpStatus,
		apiError: signal.apiError,
		rateLimitType: signal.rateLimitType,
		resetsAt: signal.resetsAt,
	});
}

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

import { PROVIDER_QUOTA_REJECTED } from "../../core/wire.ts";
import type { Repos } from "../../db/repos/index.ts";
import { detectQuotaExhausted, type QuotaExhaustedSignal } from "../../runtime/adapters/index.ts";
import { recordQuotaObservation } from "../quota/state.ts";
import type { BridgeLogger } from "../stream/types.ts";

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
 * Emit `reap.quota_exhausted` and close the credential's quota window until
 * the reset (namphuongtran/warren#30), so the next dispatch on the same
 * credential is refused instead of burning an attempt. The provider and model
 * come from the run row; the event never carries the credential, and the
 * quota state holds only its one-way fingerprint.
 */
export async function recordQuotaExhausted(
	emit: (kind: string, payload: unknown) => Promise<unknown>,
	signal: QuotaExhaustedSignal,
	run: {
		readonly id: string;
		readonly provider: string | null;
		readonly model: string | null;
	},
	state: { readonly repos: Repos; readonly now: Date; readonly logger?: BridgeLogger },
): Promise<void> {
	await emit(REAP_QUOTA_EXHAUSTED_KIND, {
		provider: run.provider,
		model: run.model,
		httpStatus: signal.httpStatus,
		apiError: signal.apiError,
		rateLimitType: signal.rateLimitType,
		resetsAt: signal.resetsAt,
	});
	// A refusal with no known reset cannot gate dispatch, so it must not
	// replace a stored window that can (namphuongtran/warren#30).
	if (signal.resetsAt === null) return;
	try {
		await recordQuotaObservation(state.repos, {
			credential: { provider: run.provider, env: process.env },
			observation: {
				status: PROVIDER_QUOTA_REJECTED,
				utilization: null,
				rateLimitType: signal.rateLimitType,
				resetsAt: signal.resetsAt,
			},
			source: "reap",
			sourceRunId: run.id,
			observedAt: state.now.toISOString(),
		});
	} catch (err) {
		// Bookkeeping only: the run still reaps `quota_exhausted` without it.
		state.logger?.warn?.(
			{ runId: run.id, err: err instanceof Error ? err.message : String(err) },
			"failed to record the spent usage window; dispatch keeps the older state",
		);
	}
}

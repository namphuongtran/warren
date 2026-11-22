/**
 * Reap-time usage-limit detection (issue #74). The harness-specific
 * recognizer lives behind the adapter registry; this is the thin async
 * wrapper plus the `reap.quota_exhausted` payload. The payload never
 * carries a credential: only provider, model and the limit's own facts.
 */

import type { Repos } from "../../db/repos/index.ts";
import { detectQuotaExhaustion } from "../../runtime/adapters/index.ts";
import type { QuotaExhaustionSignal } from "../../runtime/adapters/types.ts";

export async function detectRunQuotaExhaustion(
	repos: Repos,
	runId: string,
): Promise<QuotaExhaustionSignal | null> {
	const events = await repos.events.listByRun(runId);
	return detectQuotaExhaustion(
		events.map((e) => ({ kind: e.kind, stream: e.stream, payload: e.payloadJson })),
	);
}

export function quotaExhaustedEventPayload(
	signal: QuotaExhaustionSignal,
	run: { readonly provider: string | null; readonly model: string | null },
): Record<string, unknown> {
	return {
		provider: run.provider,
		model: run.model,
		httpStatus: signal.httpStatus,
		apiError: signal.apiError,
		rateLimitType: signal.rateLimitType,
		resetsAt: signal.resetsAt,
	};
}

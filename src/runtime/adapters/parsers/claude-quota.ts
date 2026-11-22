/**
 * Claude Code subscription-usage-limit recognizer (issue #74).
 *
 * The CLI ends a run whose usage window is exhausted with a terminal
 * `result` envelope (`is_error: true`, `api_error_status: 429` or
 * `api_error: "usage_limit_reached"`), preceded by a `rate_limit_event`
 * whose `rate_limit_info.status` is `rejected` and which carries
 * `rateLimitType` and `resetsAt` (unix seconds).
 */

import type { QuotaExhaustionSignal, QuotaScanEvent } from "../types.ts";

function asRecord(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function isQuotaResult(env: Record<string, unknown>): boolean {
	if (env.is_error !== true) return false;
	return env.api_error_status === 429 || env.api_error === "usage_limit_reached";
}

function num(value: unknown): number | null {
	return typeof value === "number" ? value : null;
}

function str(value: unknown): string | null {
	return typeof value === "string" ? value : null;
}

/** The trusted system envelope of an event, or null. */
function systemEnvelope(event: QuotaScanEvent): Record<string, unknown> | null {
	if (event.origin === "agent" || event.stream !== "system") return null;
	return asRecord(event.payload);
}

/** The `rate_limit_info` of a `rejected` rate_limit_event, or null. */
function rejectedInfo(event: QuotaScanEvent, env: Record<string, unknown>) {
	if (event.kind !== "telemetry" || env.type !== "rate_limit_event") return null;
	const info = asRecord(env.rate_limit_info);
	return info?.status === "rejected" ? info : null;
}

/** Scan persisted events; null unless the run ended on a usage-limit result. */
export function detectClaudeQuotaExhaustion(
	events: Iterable<QuotaScanEvent>,
): QuotaExhaustionSignal | null {
	let result: Record<string, unknown> | null = null;
	let rejected: Record<string, unknown> | null = null;
	for (const event of events) {
		const env = systemEnvelope(event);
		if (env === null) continue;
		if (event.kind === "state_change" && env.type === "result") {
			result = isQuotaResult(env) ? env : null;
		}
		rejected = rejectedInfo(event, env) ?? rejected;
	}
	if (result === null) return null;
	return {
		httpStatus: num(result.api_error_status),
		apiError: str(result.api_error),
		rateLimitType: str(rejected?.rateLimitType),
		resetsAt: num(rejected?.resetsAt),
	};
}

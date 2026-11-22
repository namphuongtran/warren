/**
 * claude-code usage-limit recognizer (namphuongtran/warren#74).
 *
 * When a subscription's usage window is spent, the claude CLI ends the run
 * with a terminal `result` envelope that reports an API error:
 *
 *   {"type":"result","subtype":"success","is_error":true,
 *    "api_error_status":429,"api_error_type":"rate_limit_error",
 *    "api_error":"usage_limit_reached",
 *    "result":"You've hit your 5-hour limit · resets 9:10am (UTC)"}
 *
 * A `rate_limit_event` with `rate_limit_info.status: "rejected"` comes before
 * it and names the window (`rateLimitType`) and its reset (`resetsAt`, unix
 * seconds). Evidence: runs run_cwchf800kdym and run_jy2cxd7cmg9f, 2026-11-22.
 *
 * The parser persists `result` as `state_change` and `rate_limit_event` as
 * `telemetry`, both on the system stream (`./parsers/jsonl-claude.ts`). Both
 * reads refuse an agent-authored line, the same provenance gate the shared
 * envelope extractor applies.
 */

import {
	type EventEnvelopeInput,
	extractAgentEventEnvelope,
	isAgentAuthoredEvent,
} from "../../core/event-envelope.ts";
import type { QuotaExhaustedSignal } from "./types.ts";

const USAGE_LIMIT_STATUS = 429;
const USAGE_LIMIT_ERROR = "usage_limit_reached";

type JsonObject = Record<string, unknown>;

function asObject(value: unknown): JsonObject | null {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as JsonObject)
		: null;
}

/** `rate_limit_info` of a trusted, rejected `rate_limit_event`, else `null`. */
function rejectedRateLimitInfo(event: EventEnvelopeInput): JsonObject | null {
	if (isAgentAuthoredEvent(event)) return null;
	if (event.kind !== "telemetry" || event.stream !== "system") return null;
	const payload = asObject(event.payload);
	if (payload?.type !== "rate_limit_event") return null;
	const info = asObject(payload.rate_limit_info);
	return info?.status === "rejected" ? info : null;
}

function isUsageLimitResult(result: JsonObject): boolean {
	if (result.is_error !== true) return false;
	return result.api_error_status === USAGE_LIMIT_STATUS || result.api_error === USAGE_LIMIT_ERROR;
}

function stringOrNull(value: unknown): string | null {
	return typeof value === "string" && value.length > 0 ? value : null;
}

function numberOrNull(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * The last `result` envelope decides, so a run that recovered and ended
 * normally is not blamed on an earlier refusal. The window details come from
 * the last rejected rate-limit event, when one was recorded.
 */
export function detectClaudeQuotaExhausted(
	events: readonly EventEnvelopeInput[],
): QuotaExhaustedSignal | null {
	let result: JsonObject | null = null;
	let rejected: JsonObject | null = null;
	for (const event of events) {
		const envelope = extractAgentEventEnvelope(event);
		if (envelope?.type === "result") {
			result = envelope.payload;
			continue;
		}
		rejected = rejectedRateLimitInfo(event) ?? rejected;
	}
	if (result === null || !isUsageLimitResult(result)) return null;
	return {
		httpStatus: numberOrNull(result.api_error_status),
		apiError: stringOrNull(result.api_error),
		rateLimitType: stringOrNull(rejected?.rateLimitType),
		resetsAt: numberOrNull(rejected?.resetsAt),
	};
}

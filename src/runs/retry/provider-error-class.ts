/**
 * The provider-error retry discriminator (warren-339d), split out of
 * `./provider-retry.ts` for its file-size budget. That module re-exports
 * {@link classifyProviderError}; the retry policy around it lives there.
 */

/**
 * The retry verdict for a provider's terminal error message.
 *   - `transient` — network-class / upstream-class failure; worth one retry.
 *   - `durable`   — the provider rejected the request itself; a retry fails
 *                   the same way (auth, model, quota, rate-limit, 4xx).
 *   - `unknown`   — unrecognized; fails CLOSED (no retry).
 */
export type ProviderErrorClass = "transient" | "durable" | "unknown";

/**
 * Durable rejection patterns, checked FIRST — a message that names both a
 * network symptom and an auth/quota cause ("request failed: 401 ...") must
 * not retry. Case-insensitive substring/regex match against the provider's
 * terminal `errorMessage`.
 */
const DURABLE_PATTERNS: readonly RegExp[] = [
	// Auth / permission.
	/\b401\b/,
	/\b403\b/,
	/unauthorized/,
	/unauthenticated/,
	/authentication/,
	/invalid\s.*api[-_ ]?key/,
	/api[-_ ]?key/,
	/permission denied/,
	/forbidden/,
	// Model rejection.
	/model.*(not found|does not exist|not supported|invalid)/,
	/(not found|does not exist|invalid).*model/,
	/no such model/,
	/not_found_error/,
	/\b404\b/,
	// Quota / billing.
	/\b402\b/,
	/credit balance/,
	/quota/,
	/billing/,
	/insufficient/,
	// Rate limiting — a run-level redispatch has no backoff worth the name,
	// so an immediate retry would just hit the limiter again.
	/\b429\b/,
	/rate[ -]?limit/,
	/too many requests/,
	// A subscription plan's usage cap (Codex on a ChatGPT login, namphuongtran/warren#17).
	/usage limit/,
	// Context overflow: the same prompt overflows again on a fresh run.
	/context[_ ]?(window|length)/,
	/maximum context/,
	/ran out of room/,
	// Malformed request.
	/\b400\b/,
	/invalid_request/,
];

/** Transient network/upstream patterns — the only class that retries. */
const TRANSIENT_PATTERNS: readonly RegExp[] = [
	// Connection-class (the warren-339d case: "Network connection lost.").
	/network connection lost/,
	/connection (lost|reset|refused|closed|aborted|terminated)/,
	/econnreset/,
	/econnrefused/,
	/econnaborted/,
	/epipe/,
	/socket hang up/,
	/socket.*(closed|timeout)/,
	// Stream breaks can arrive after headers with no status/body left to parse.
	/stream ended/,
	// Codex's spelling of the same break (namphuongtran/warren#17).
	/stream disconnected/,
	/without finish_reason/,
	// The provider can also end the stream with an explicit error finish
	// (`Provider finish_reason: error`, run_03wb2b8crbz6 on 2026-09-03, #1238):
	// same upstream break, just spelled from the other side.
	/finish_reason:?\s*error/,
	/premature close/,
	/\baborted\b/,
	/fetch failed/,
	/network error/,
	/\bnetwork\b/,
	/dns/,
	/eai_again/,
	// Timeout-class.
	/etimedout/,
	/esockettimedout/,
	/\btimeout\b/,
	/timed out/,
	// Upstream 5xx / overload (529 overloaded_error — cf. warren-e281).
	/\b5\d\d\b/,
	/internal server error/,
	/bad gateway/,
	/service unavailable/,
	/gateway timeout/,
	/overloaded/,
	/upstream/,
];

/**
 * Classify a provider's terminal error for retry. The structured
 * `httpStatus` (captured on the `reap.provider_error` payload by
 * warren-4001's enrichment) wins over prose parsing: a 5xx whose prose
 * never spells out the code must not fail closed as `unknown`
 * (warren-f8b2). Durable wins over transient when both match; no match
 * fails closed as `unknown`. Pure + defensive: any input (empty,
 * whitespace, non-string coerced by the caller, non-finite status)
 * classifies without throwing.
 */
export function classifyProviderError(
	message: string,
	httpStatus?: number | null,
	upstreamBody?: string | null,
): ProviderErrorClass {
	if (typeof httpStatus === "number" && Number.isFinite(httpStatus)) {
		if (httpStatus >= 500) return "transient";
		if (httpStatus >= 400 && httpStatus < 500) return "durable";
	}
	// Tier 2 (warren-eaa6): the structured upstream body carries the
	// provider's real rejection text even when the harness's surface
	// message is opaque (pi's `Provider returned error`). Classify it
	// before falling back to the free-prose message.
	if (typeof upstreamBody === "string" && upstreamBody.length > 0) {
		const bodyVerdict = classifyText(upstreamBody);
		if (bodyVerdict !== "unknown") return bodyVerdict;
	}
	return classifyText(message);
}

/** The prose tier: durable wins over transient; no match fails closed. */
function classifyText(text: string): ProviderErrorClass {
	const lower = text.toLowerCase();
	if (DURABLE_PATTERNS.some((p) => p.test(lower))) return "durable";
	if (TRANSIENT_PATTERNS.some((p) => p.test(lower))) return "transient";
	return "unknown";
}

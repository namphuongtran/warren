/**
 * The reviewer verdict contract (namphuongtran/warren#18).
 *
 * A `reviewer` run is read-only: it pushes nothing, so its only output is
 * its handoff report (namphuongtran/warren#21). The reviewer writes the verdict under
 * the report's `review` key:
 *
 *     {"status":"done","summary":"...",
 *      "review":{"verdict":"approve"|"request_changes","summary":"...",
 *       "findings":[{"title":"...","body":"...","path":"src/x.ts","line":12}]}}
 *
 * Warren validates the report at reap (`src/core/wire-handoff.ts` in core)
 * and serves it on `GET /runs/:id`. The controller reads it there first.
 *
 * The fallback is the transcript block an older warren's reviewer ends its
 * final message with:
 *
 *     <warren-review-verdict>
 *     {"verdict":"approve","summary":"...","findings":[]}
 *     </warren-review-verdict>
 *
 * That block is read from `GET /runs/:id/events`, from `kind: "text"` events
 * only (the agent's own words), and only when it is the last thing the agent
 * wrote. Tool output is never searched, so a file under review that quotes
 * the tags cannot plant a verdict.
 *
 * Everything parsed here is untrusted agent output, whichever source it came
 * from: sizes are capped, the shape is checked again here rather than taken
 * on warren's word, and the findings are data for the fixer prompt, never
 * instructions.
 */

import type { WarrenRunHandoff } from "../warren-client.ts";

export const REVIEW_VERDICT_OPEN = "<warren-review-verdict>";
export const REVIEW_VERDICT_CLOSE = "</warren-review-verdict>";

/** Most findings one verdict may carry; extras are dropped. */
export const MAX_FINDINGS = 25;
/** Longest finding body kept; longer bodies are truncated. */
export const MAX_FINDING_BODY_CHARS = 2_000;
/** Longest finding title kept. */
export const MAX_FINDING_TITLE_CHARS = 200;
/** Longest summary kept. */
export const MAX_SUMMARY_CHARS = 2_000;
/** Largest verdict block (JSON text) the parser will read. */
export const MAX_VERDICT_BLOCK_CHARS = 128_000;

export const REVIEW_VERDICTS = ["approve", "request_changes"] as const;
export type ReviewVerdictValue = (typeof REVIEW_VERDICTS)[number];

export interface ReviewFinding {
	readonly title: string;
	readonly body: string;
	readonly path: string | null;
	readonly line: number | null;
}

export interface ReviewVerdict {
	readonly verdict: ReviewVerdictValue;
	readonly summary: string;
	readonly findings: readonly ReviewFinding[];
}

export type VerdictFailureReason =
	| "verdict_missing"
	| "verdict_not_final"
	| "verdict_too_large"
	| "verdict_invalid_json"
	| "verdict_invalid_shape"
	// A recorded handoff report was the expected source and is not usable.
	| "handoff_missing"
	| "handoff_invalid";

export type VerdictParseResult =
	| { readonly ok: true; readonly verdict: ReviewVerdict }
	| { readonly ok: false; readonly reason: VerdictFailureReason };

/**
 * Parse the verdict block that ENDS `text`. The reviewer is told to put
 * nothing after it, and requiring that is what stops a block quoted from the
 * diff (and echoed into the reviewer's own words mid-transcript) from
 * standing in for a verdict the reviewer never gave.
 */
export function parseReviewVerdict(text: string): VerdictParseResult {
	const close = text.lastIndexOf(REVIEW_VERDICT_CLOSE);
	const open = close === -1 ? -1 : text.lastIndexOf(REVIEW_VERDICT_OPEN, close);
	if (open === -1 || close === -1) {
		return { ok: false, reason: "verdict_missing" };
	}
	if (text.slice(close + REVIEW_VERDICT_CLOSE.length).trim() !== "") {
		return { ok: false, reason: "verdict_not_final" };
	}
	const body = text.slice(open + REVIEW_VERDICT_OPEN.length, close).trim();
	if (body.length > MAX_VERDICT_BLOCK_CHARS) {
		return { ok: false, reason: "verdict_too_large" };
	}
	let raw: unknown;
	try {
		raw = JSON.parse(body);
	} catch {
		return { ok: false, reason: "verdict_invalid_json" };
	}
	const verdict = narrowVerdict(raw);
	return verdict === null ? { ok: false, reason: "verdict_invalid_shape" } : { ok: true, verdict };
}

/** One run event as `GET /runs/:id/events` serves it (fields the parser reads). */
export interface VerdictSourceEvent {
	readonly seq?: unknown;
	readonly kind?: unknown;
	readonly payload?: unknown;
}

/**
 * Read the verdict from a run's events. Only `kind: "text"` payloads are
 * joined, in `seq` order, so a block a harness split across two text events
 * still parses.
 */
export function extractReviewVerdict(events: readonly VerdictSourceEvent[]): VerdictParseResult {
	const texts = events
		.filter((event) => event.kind === "text")
		.map((event) => ({ seq: typeof event.seq === "number" ? event.seq : 0, text: textOf(event) }))
		.filter((entry) => entry.text.length > 0)
		.sort((a, b) => a.seq - b.seq)
		.map((entry) => entry.text);
	return parseReviewVerdict(texts.join(""));
}

/**
 * The verdict of a settled reviewer run. A recorded handoff `review` block
 * wins, and the events are not read at all. Without one, the transcript
 * block is the fallback. That covers a warren that predates the handoff
 * report, and also a policy `agent` that still speaks the transcript
 * grammar on a current warren; the block is read under the same guards
 * either way. When neither exists and the handoff is missing or
 * invalid, the failure names the handoff, because that is what the reviewer
 * was asked to write.
 */
export async function readReviewVerdict(
	handoff: WarrenRunHandoff | null,
	readEvents: () => Promise<readonly VerdictSourceEvent[]>,
): Promise<VerdictParseResult> {
	if (handoff?.state === "recorded" && handoff.review !== null) {
		const verdict = narrowVerdict(handoff.review);
		return verdict === null
			? { ok: false, reason: "verdict_invalid_shape" }
			: { ok: true, verdict };
	}
	const parsed = extractReviewVerdict(await readEvents());
	if (parsed.ok || parsed.reason !== "verdict_missing" || handoff === null) {
		return parsed;
	}
	if (handoff.state === "missing") return { ok: false, reason: "handoff_missing" };
	if (handoff.state === "invalid") return { ok: false, reason: "handoff_invalid" };
	return parsed;
}

function textOf(event: VerdictSourceEvent): string {
	const payload = event.payload;
	if (typeof payload !== "object" || payload === null) return "";
	const text = (payload as Record<string, unknown>).text;
	return typeof text === "string" ? text : "";
}

function narrowVerdict(raw: unknown): ReviewVerdict | null {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
	const row = raw as Record<string, unknown>;
	if (!REVIEW_VERDICTS.includes(row.verdict as ReviewVerdictValue)) return null;
	if (typeof row.summary !== "string" || row.summary.trim() === "") return null;
	if (!Array.isArray(row.findings)) return null;
	const findings: ReviewFinding[] = [];
	for (const item of row.findings.slice(0, MAX_FINDINGS)) {
		const finding = narrowFinding(item);
		if (finding === null) return null;
		findings.push(finding);
	}
	const verdict = row.verdict as ReviewVerdictValue;
	// A change request with nothing to change gives the fixer no work and
	// the operator no reason; refuse it rather than loop on it.
	if (verdict === "request_changes" && findings.length === 0) return null;
	return { verdict, summary: row.summary.slice(0, MAX_SUMMARY_CHARS), findings };
}

function narrowFinding(raw: unknown): ReviewFinding | null {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
	const row = raw as Record<string, unknown>;
	if (typeof row.title !== "string" || row.title.trim() === "") return null;
	if (typeof row.body !== "string" || row.body.trim() === "") return null;
	const path = typeof row.path === "string" && row.path.length > 0 ? row.path.slice(0, 500) : null;
	const line =
		typeof row.line === "number" && Number.isInteger(row.line) && row.line > 0 ? row.line : null;
	return {
		title: row.title.slice(0, MAX_FINDING_TITLE_CHARS),
		body: row.body.slice(0, MAX_FINDING_BODY_CHARS),
		path,
		line,
	};
}

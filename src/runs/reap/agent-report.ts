/**
 * The agent's final report for the PR body's `## Agent report` section
 * (namphuongtran/warren#42).
 *
 * The final message is the text of the LAST assistant `text` event before the
 * terminal `result` envelope. It is deliberately NOT the `result` payload's
 * `result` field: after a background task resumes a claude-code session, that
 * field can still hold an earlier turn's text (measured on run
 * `run_bp7s34zhq5vb`, where `result.result` said the work was unfinished and
 * the last `text` event said it was committed).
 *
 * Harness-neutral: every shipped adapter maps assistant prose to a `text`
 * event with a `{ text }` payload. A harness with no `result` envelope falls
 * back to the run's last assistant text overall.
 */

import type { Repos } from "../../db/repos/index.ts";

/** The event fields the extractor reads; matches a persisted `EventRow`. */
export interface AgentReportEvent {
	readonly kind: string;
	readonly sandboxEventSeq: number;
	readonly payloadJson: unknown;
}

const REPORT_EVENT_KINDS = ["text", "state_change"] as const;

function asRecord(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function isTerminalResult(ev: AgentReportEvent): boolean {
	return ev.kind === "state_change" && asRecord(ev.payloadJson)?.type === "result";
}

/**
 * The assistant prose an event carries, or null. Parse-error lines and the
 * raw-envelope / unknown-block `text` fallbacks are not assistant prose; a raw
 * envelope keeps its harness `type`, an assistant text payload has none.
 */
function assistantText(ev: AgentReportEvent): string | null {
	if (ev.kind !== "text") return null;
	const payload = asRecord(ev.payloadJson);
	if (payload === null || payload.parseError !== undefined || payload.type !== undefined) {
		return null;
	}
	const text = payload.text;
	if (typeof text !== "string" || text.trim() === "") return null;
	return text;
}

/** Pure: pick the final report out of a run's events (any order). */
export function extractAgentReport(events: readonly AgentReportEvent[]): string | null {
	const ordered = [...events].sort((a, b) => a.sandboxEventSeq - b.sandboxEventSeq);
	let end = ordered.length;
	for (let i = ordered.length - 1; i >= 0; i--) {
		const ev = ordered[i];
		if (ev !== undefined && isTerminalResult(ev)) {
			end = i;
			break;
		}
	}
	for (let i = end - 1; i >= 0; i--) {
		const ev = ordered[i];
		const text = ev === undefined ? null : assistantText(ev);
		if (text !== null) return text;
	}
	return null;
}

/**
 * Best-effort load of a run's final report. Reads only the `text` and
 * `state_change` rows; a read error resolves to null so the PR still opens.
 */
export async function loadAgentReport(
	events: Pick<Repos["events"], "listEventsByKindsForRuns">,
	runId: string,
): Promise<string | null> {
	try {
		return extractAgentReport(await events.listEventsByKindsForRuns([runId], REPORT_EVENT_KINDS));
	} catch {
		return null;
	}
}

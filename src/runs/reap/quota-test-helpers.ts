import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { EventEnvelopeInput } from "../../core/event-envelope.ts";
import { adapterFor } from "../../runtime/adapters/index.ts";

/**
 * Replay a recorded claude stdout fixture through the real parser, shaped as
 * the persisted event rows reap reads. The fixtures are trimmed from the event
 * logs of run_cwchf800kdym and run_jy2cxd7cmg9f (namphuongtran/warren#74).
 */
export function claudeEvents(fixture: string): EventEnvelopeInput[] {
	const parse = adapterFor("claude-code").parseEvents;
	if (parse === undefined) throw new Error("claude-code has no parser");
	const text = readFileSync(join(import.meta.dir, "__fixtures__", fixture), "utf8");
	return text
		.split("\n")
		.flatMap((line) => parse(line))
		.map((ev) => ({ kind: ev.kind, stream: ev.stream, origin: "warren", payload: ev.payload }));
}

/** Rewrite the terminal `result` envelope, keeping every other event as recorded. */
export function withResult(
	events: readonly EventEnvelopeInput[],
	patch: Record<string, unknown>,
): EventEnvelopeInput[] {
	return events.map((ev) => {
		const payload = ev.payload as Record<string, unknown>;
		return payload.type === "result" ? { ...ev, payload: { ...payload, ...patch } } : ev;
	});
}

/** Drop the `rejected` rate-limit events, leaving the run's warnings in place. */
export function withoutRejection(events: readonly EventEnvelopeInput[]): EventEnvelopeInput[] {
	return events.filter((ev) => {
		const payload = ev.payload as { rate_limit_info?: { status?: string } };
		return payload.rate_limit_info?.status !== "rejected";
	});
}

/**
 * The run approach note (namphuongtran/warren#33), re-exported from wire.ts so
 * the canonical home stays one module.
 *
 * A source-editing run writes `.warren/approach.md` before its first edit:
 * how it understood the task, the options it weighed, the one it chose and
 * why, the risks, and how it will verify the work. The file sits outside the
 * committed tree (a run git-exclude keeps it off the branch). Finalize
 * collects it on every provider, reap stores the result here on the run, and
 * the handoff report's `approach` block says whether the work followed it.
 *
 * The note is free Markdown, so the only checks are presence and the size
 * cap. It is agent output: a consumer renders it escaped.
 */

/** Workspace-relative path of the approach note. */
export const RUN_APPROACH_PATH = ".warren/approach.md";

/** UTF-8 byte cap on the stored note. A longer note is truncated, not rejected. */
export const RUN_APPROACH_MAX_BYTES = 16 * 1024;

/**
 * The fixed headings the note is written under, in order. They are guidance
 * for the agent and the reader; reap does not enforce them, because a trivial
 * task may write a one-line approach instead.
 */
export const RUN_APPROACH_HEADINGS = [
	"Understanding",
	"Options considered",
	"Chosen approach and why",
	"Risks / unknowns",
	"Verification plan",
] as const;

/**
 * Bound a collected body before it crosses a process or network boundary.
 * One character past the cap is enough for {@link parseRunApproach} to mark
 * the stored note truncated, so a runaway file never rides the finalize wire.
 */
export function clipRunApproachBody(body: string): string {
	return body.length > RUN_APPROACH_MAX_BYTES ? body.slice(0, RUN_APPROACH_MAX_BYTES + 1) : body;
}

/**
 * What reap found when it looked for the note:
 * - `recorded` — the note, stored with the run (truncated past the cap).
 * - `missing` — the run wrote no note, or an empty one. Informational only.
 */
export const RUN_APPROACH_STATES = ["recorded", "missing"] as const;
export type RunApproachState = (typeof RUN_APPROACH_STATES)[number];

/** The approach result stored on the run and served on `GET /runs/:id`. */
export type RunApproachRecord =
	| { readonly state: "recorded"; readonly markdown: string; readonly truncated: boolean }
	| { readonly state: "missing"; readonly reason: string };

/** The longest prefix of `bytes` within `max` bytes that ends on a UTF-8 character boundary. */
function truncateUtf8(bytes: Uint8Array, max: number): string {
	let end = max;
	// A continuation byte (0b10xxxxxx) means the cut lands inside a character.
	while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end--;
	return new TextDecoder().decode(bytes.subarray(0, end));
}

/** Read the raw note body. `null` means the file was absent. */
export function parseRunApproach(body: string | null): RunApproachRecord {
	if (body === null) {
		return { state: "missing", reason: `the run did not write ${RUN_APPROACH_PATH}` };
	}
	if (body.trim() === "") return { state: "missing", reason: `${RUN_APPROACH_PATH} is empty` };
	const bytes = new TextEncoder().encode(body);
	if (bytes.length <= RUN_APPROACH_MAX_BYTES) {
		return { state: "recorded", markdown: body, truncated: false };
	}
	return {
		state: "recorded",
		markdown: truncateUtf8(bytes, RUN_APPROACH_MAX_BYTES),
		truncated: true,
	};
}

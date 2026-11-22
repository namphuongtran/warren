/**
 * The run handoff report (namphuongtran/warren#21), split out of wire.ts
 * under the file-size budget and re-exported from there so the canonical home
 * stays one module.
 *
 * Every run writes `.warren/handoff.json` before it ends. The file sits
 * outside the committed tree (a run git-exclude keeps it off the branch).
 * Reap collects it on every provider, validates it here, stores the result
 * on the run, and renders it into the PR body.
 *
 * The validator is pure and dependency-free so the reap step, the plan-run
 * prompt chaining, and any consumer read one definition.
 */

/** Workspace-relative path of the handoff file. */
export const RUN_HANDOFF_PATH = ".warren/handoff.json";

/** UTF-8 byte cap on the handoff file. A bigger file is rejected unparsed. */
export const RUN_HANDOFF_MAX_BYTES = 16 * 1024;

/**
 * Bound a collected body before it crosses a process or network boundary.
 * Keeping one character past the byte cap is enough for the validator to
 * reject it as oversized, so a runaway file never rides the finalize wire.
 */
export function clipRunHandoffBody(body: string): string {
	return body.length > RUN_HANDOFF_MAX_BYTES ? body.slice(0, RUN_HANDOFF_MAX_BYTES + 1) : body;
}

/**
 * How the agent says the work ended:
 * - `done` — the task is complete.
 * - `partial` — some of it landed; the summary says what is left.
 * - `blocked` — the agent could not proceed; `openQuestions` says why.
 */
export const RUN_HANDOFF_STATUSES = ["done", "partial", "blocked"] as const;
export type RunHandoffStatus = (typeof RUN_HANDOFF_STATUSES)[number];

/** Membership predicate for {@link RUN_HANDOFF_STATUSES}. */
export function isRunHandoffStatus(value: unknown): value is RunHandoffStatus {
	return typeof value === "string" && (RUN_HANDOFF_STATUSES as readonly string[]).includes(value);
}

/**
 * What reap found when it looked for the file:
 * - `recorded` — a valid handoff, stored with the run.
 * - `missing` — the run ended without writing the file.
 * - `invalid` — the file exists but fails the schema or the size cap.
 */
export const RUN_HANDOFF_STATES = ["recorded", "missing", "invalid"] as const;
export type RunHandoffState = (typeof RUN_HANDOFF_STATES)[number];

/** One verification step the agent ran. */
export interface RunHandoffVerification {
	readonly command: string;
	readonly outcome: string;
}

/** The validated handoff report. Optional lists default to empty. */
export interface RunHandoff {
	readonly status: RunHandoffStatus;
	/** What changed and why. */
	readonly summary: string;
	/** Commands run and their outcome. */
	readonly verification: readonly RunHandoffVerification[];
	/** Steps a human can follow to try the change. */
	readonly howToTry: readonly string[];
	/** Decisions the agent could not make. */
	readonly openQuestions: readonly string[];
}

/** The handoff result stored on the run and served on `GET /runs/:id`. */
export type RunHandoffRecord =
	| { readonly state: "recorded"; readonly handoff: RunHandoff }
	| { readonly state: "missing" | "invalid"; readonly reason: string };

const MISSING_REASON = `the run did not write ${RUN_HANDOFF_PATH}`;

type Field<T> =
	| { readonly ok: true; readonly value: T }
	| { readonly ok: false; readonly reason: string };

function invalid(reason: string): RunHandoffRecord {
	return { state: "invalid", reason };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringList(raw: Record<string, unknown>, key: string): Field<readonly string[]> {
	const value = raw[key];
	if (value === undefined) return { ok: true, value: [] };
	if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
		return { ok: true, value };
	}
	return { ok: false, reason: `${key} must be an array of strings` };
}

function verificationList(raw: Record<string, unknown>): Field<readonly RunHandoffVerification[]> {
	const value = raw.verification;
	if (value === undefined) return { ok: true, value: [] };
	if (!Array.isArray(value)) return { ok: false, reason: "verification must be an array" };
	const steps: RunHandoffVerification[] = [];
	for (const [index, item] of value.entries()) {
		if (!isRecord(item) || typeof item.command !== "string" || typeof item.outcome !== "string") {
			return {
				ok: false,
				reason: `verification[${index}] must be an object with string command and outcome`,
			};
		}
		steps.push({ command: item.command, outcome: item.outcome });
	}
	return { ok: true, value: steps };
}

function parseJsonObject(body: string): Field<Record<string, unknown>> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(body);
	} catch {
		return { ok: false, reason: `${RUN_HANDOFF_PATH} is not valid JSON` };
	}
	if (!isRecord(parsed)) {
		return { ok: false, reason: `${RUN_HANDOFF_PATH} must hold a JSON object` };
	}
	return { ok: true, value: parsed };
}

/**
 * Validate the raw handoff file body. `null` means the file was absent.
 * Unknown keys are dropped, so the stored record carries only the schema.
 */
export function parseRunHandoff(body: string | null): RunHandoffRecord {
	if (body === null) return { state: "missing", reason: MISSING_REASON };
	if (new TextEncoder().encode(body).length > RUN_HANDOFF_MAX_BYTES) {
		return invalid(`${RUN_HANDOFF_PATH} is over the ${RUN_HANDOFF_MAX_BYTES / 1024} KiB limit`);
	}
	const object = parseJsonObject(body);
	if (!object.ok) return invalid(object.reason);
	const raw = object.value;
	if (!isRunHandoffStatus(raw.status)) {
		return invalid(`status must be one of ${RUN_HANDOFF_STATUSES.join(", ")}`);
	}
	if (typeof raw.summary !== "string" || raw.summary.trim() === "") {
		return invalid("summary must be a non-empty string");
	}
	const verification = verificationList(raw);
	if (!verification.ok) return invalid(verification.reason);
	const howToTry = stringList(raw, "howToTry");
	if (!howToTry.ok) return invalid(howToTry.reason);
	const openQuestions = stringList(raw, "openQuestions");
	if (!openQuestions.ok) return invalid(openQuestions.reason);
	return {
		state: "recorded",
		handoff: {
			status: raw.status,
			summary: raw.summary,
			verification: verification.value,
			howToTry: howToTry.value,
			openQuestions: openQuestions.value,
		},
	};
}

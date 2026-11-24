/**
 * Held dispatches (namphuongtran/warren#30).
 *
 * A `POST /runs` with `onQuotaExhausted: "hold"` that the provider-quota
 * guard refuses is not answered 429. `spawnOrHoldRun` creates the run row
 * `queued` with no workload instead, and this module records why it waits on
 * a `dispatch.quota_held` event. The event carries the serializable part of
 * the dispatch request, so the hold releaser (`./hold-release.ts`) can replay
 * the same request onto the same row once the window reopens. The client
 * keeps its run id throughout, and a held run cancels like any queued run.
 *
 * There is no table: the run row and the newest hold event are the state,
 * so a hold survives a restart. Secrets never ride the event. The release
 * mints its own git credential.
 */

import { StateTransitionError } from "../../core/errors.ts";
import {
	CLONE_KINDS,
	PROVIDER_QUOTA_EXHAUSTED,
	QUOTA_HOLD_EVENTS,
	type QuotaHoldView,
	RUN_MODES,
} from "../../core/wire.ts";
import type { Repos } from "../../db/repos/index.ts";
import type { EventRow, RunRow } from "../../db/schema.ts";
import { MULCH_ARM_VALUES } from "../../runtime/adapters/mulch-arm.ts";
import type { RunEventBroker } from "../events.ts";
import { DISPATCH_ORIGINS, type SpawnRunInput } from "../spawn/types.ts";
import { appendRunSystemEvent } from "../stream/system-event.ts";

/** Wait this long past the reset, so the provider's clock has surely rolled over. */
export const QUOTA_RELEASE_DELAY_SECONDS = 60;
/** Spread releases on one credential over this many seconds after the delay. */
export const QUOTA_RELEASE_JITTER_SECONDS = 120;

/** When work waiting on a window that resets at `resetsAt` (unix seconds) may start. */
export function releaseAtAfter(resetsAt: number, random: () => number = Math.random): string {
	const jitter = Math.floor(random() * QUOTA_RELEASE_JITTER_SECONDS);
	return new Date((resetsAt + QUOTA_RELEASE_DELAY_SECONDS + jitter) * 1000).toISOString();
}

const STRING_FIELDS = [
	"agentName",
	"projectId",
	"prompt",
	"trigger",
	"seedId",
	"providerOverride",
	"modelOverride",
	"ref",
	"baseCommit",
	"parentRunId",
	"retryOf",
	"targetBranch",
	"existingBranch",
	"newBranch",
	"dispatcherHandle",
] as const;
const NUMBER_FIELDS = ["maxCostUsdOverride", "maxDurationMinutesOverride"] as const;
const ENUM_FIELDS = {
	mode: RUN_MODES,
	cloneKind: CLONE_KINDS,
	mulchArm: MULCH_ARM_VALUES,
	dispatchOrigin: DISPATCH_ORIGINS,
} as const;

type HeldRequestField =
	| (typeof STRING_FIELDS)[number]
	| (typeof NUMBER_FIELDS)[number]
	| keyof typeof ENUM_FIELDS
	| "metadata";

/** The part of a dispatch request a held run replays at its release. */
export type HeldDispatchRequest = Pick<SpawnRunInput, HeldRequestField>;

export function heldDispatchRequest(input: SpawnRunInput): HeldDispatchRequest {
	const fields: readonly HeldRequestField[] = [
		...STRING_FIELDS,
		...NUMBER_FIELDS,
		...(Object.keys(ENUM_FIELDS) as (keyof typeof ENUM_FIELDS)[]),
		"metadata",
	];
	const out: Record<string, unknown> = {};
	for (const field of fields) {
		if (input[field] !== undefined) out[field] = input[field];
	}
	return out as HeldDispatchRequest;
}

/** Read a request back off a `dispatch.quota_held` payload; `null` when it is unusable. */
export function readHeldRequest(raw: unknown): HeldDispatchRequest | null {
	if (raw === null || typeof raw !== "object") return null;
	const source = raw as Record<string, unknown>;
	const out: Record<string, unknown> = {};
	for (const field of STRING_FIELDS) {
		if (typeof source[field] === "string") out[field] = source[field];
	}
	for (const field of NUMBER_FIELDS) {
		const value = source[field];
		if (typeof value === "number" && Number.isFinite(value)) out[field] = value;
	}
	for (const [field, allowed] of Object.entries(ENUM_FIELDS)) {
		const value = source[field];
		if ((allowed as readonly unknown[]).includes(value)) out[field] = value;
	}
	if (source.metadata !== undefined) out.metadata = source.metadata;
	const required = [out.agentName, out.projectId, out.prompt];
	return required.every((v) => typeof v === "string") ? (out as HeldDispatchRequest) : null;
}

export interface HeldDecision {
	readonly resetsAt: number;
	readonly releaseAt: string;
	readonly request: HeldDispatchRequest;
}

/** Read a `dispatch.quota_held` payload; `null` when it is unusable. */
export function readHeldDecision(payload: unknown): HeldDecision | null {
	if (payload === null || typeof payload !== "object") return null;
	const p = payload as { resetsAt?: unknown; releaseAt?: unknown; request?: unknown };
	if (typeof p.resetsAt !== "number" || !Number.isFinite(p.resetsAt)) return null;
	if (typeof p.releaseAt !== "string" || Number.isNaN(Date.parse(p.releaseAt))) return null;
	const request = readHeldRequest(p.request);
	return request === null ? null : { resetsAt: p.resetsAt, releaseAt: p.releaseAt, request };
}

export interface RecordQuotaHoldInput {
	readonly runId: string;
	readonly request: HeldDispatchRequest;
	/** When the window reopens, unix seconds, from the guard's refusal. */
	readonly resetsAt: number;
	readonly now: Date;
	readonly random?: () => number;
	/** Fans the event out to live subscribers; the client replays it from the log anyway. */
	readonly broker?: Pick<RunEventBroker, "publish">;
}

/** Append the `dispatch.quota_held` event and return the hold it describes. */
export async function recordQuotaHold(
	repos: Pick<Repos, "events">,
	input: RecordQuotaHoldInput,
): Promise<QuotaHoldView> {
	const { resetsAt } = input;
	const hold: QuotaHoldView = {
		reason: PROVIDER_QUOTA_EXHAUSTED,
		resetsAt,
		releaseAt: releaseAtAfter(resetsAt, input.random),
	};
	await appendRunSystemEvent(repos, input.broker, {
		runId: input.runId,
		kind: QUOTA_HOLD_EVENTS.held,
		payload: { ...hold, request: input.request },
		ts: input.now.toISOString(),
	});
	return hold;
}

/** Every hold event kind, for reading a page of runs' hold state in one query. */
export const QUOTA_HOLD_KINDS: readonly string[] = Object.values(QUOTA_HOLD_EVENTS);

/**
 * The newest hold event per run, from hold events across any number of runs.
 * The newest one says where each hold stands (see {@link QUOTA_HOLD_EVENTS}).
 */
export function newestHoldEventByRun(events: readonly EventRow[]): Map<string, EventRow> {
	const newest = new Map<string, EventRow>();
	for (const event of events) {
		const seen = newest.get(event.runId);
		if (seen === undefined || event.sandboxEventSeq > seen.sandboxEventSeq) {
			newest.set(event.runId, event);
		}
	}
	return newest;
}

/** A held run is still waiting: queued, with no workload attached. */
export function isHeldRunPending(run: RunRow): boolean {
	return run.state === "queued" && run.sandboxRunId === null;
}

/** The held run was cancelled, or launched by someone else, before its release. */
export class HeldRunNotPendingError extends StateTransitionError {}

export async function requireHeldRunPending(
	repos: Pick<Repos, "runs">,
	runId: string,
): Promise<RunRow> {
	const run = await repos.runs.require(runId);
	if (!isHeldRunPending(run)) {
		throw new HeldRunNotPendingError(`held run ${runId} is no longer waiting (state ${run.state})`);
	}
	return run;
}

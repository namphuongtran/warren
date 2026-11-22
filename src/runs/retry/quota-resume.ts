/**
 * Quota auto-resume (namphuongtran/warren#30 Phase 2).
 *
 * A run the provider refused because the credential's usage window is spent
 * reaps `failed`/`quota_exhausted` (#74), and Phase 1 closes dispatch on that
 * credential until the reset. This module picks the work back up once the
 * window reopens: it schedules the failed run to resume at `resetsAt` plus a
 * short delay and jitter, and at that time dispatches a successor.
 *
 * - The successor builds on the stopped run's pushed commits when there are
 *   any (`continue` mode), and otherwise re-dispatches its config from the
 *   same base (`replicate` mode). {@link resumeBase} picks the branch.
 * - One lineage gets at most {@link MAX_QUOTA_RESUMES} resumes. Each successor
 *   carries a `spawn.quota_resume` stamp naming the run it resumed, and the
 *   count walks those stamps back toward the root.
 *
 * ## State lives on the stream
 *
 * There is no table. The failed run row and its decision events are the
 * state, so a pending resume survives a restart: the newest decision event
 * on the failed run says where it stands.
 *
 * | Newest decision event | Meaning |
 * |---|---|
 * | none | not decided yet (the tick decides it) |
 * | `reap.quota_resume_scheduled` | waiting for `resumeAt` |
 * | `reap.quota_resume_started` | a dispatch began and never recorded its end |
 * | `dispatched` / `failed` / `exhausted` / `skipped` | done |
 *
 * `scheduleRun` (the `post_reap` hook) only decides. `tick` decides any run
 * the hook missed and dispatches the due ones, one at a time, so a resume is
 * never dispatched twice. The `started` claim goes on the stream before the
 * spawn: if the process dies mid-dispatch, the next tick records the resume
 * as failed instead of spawning a second successor.
 *
 * A due resume refused by the Phase 1 guard (a newer report moved the reset)
 * is scheduled again at the new reset without spending an attempt. An
 * automatic-trigger run that the automatic-run cap turns away stays scheduled
 * and is tried on the next tick.
 */

import type { Repos } from "../../db/repos/index.ts";
import type { EventRow, RunRow } from "../../db/schema.ts";
import type { Forge } from "../../forge/contract.ts";
import { mintGitCredential } from "../../forge/credentials.ts";
import type { SpawnFn as ProjectSpawnFn } from "../../projects/clone.ts";
import type { ProjectsConfig } from "../../projects/config.ts";
import type { RuntimeProvider } from "../../runtime/contract.ts";
import type { SeedsCliDeps } from "../../seeds-cli/index.ts";
import type { IssueTracker } from "../../tracker/contract.ts";
import {
	isAutomaticRunTrigger,
	withAutomaticRunAdmission,
} from "../../triggers/automatic-capacity.ts";
import type { WarrenConfigCache } from "../../warren-config/index.ts";
import type { RunEventBroker } from "../events.ts";
import { quotaKey } from "../quota/fingerprint.ts";
import { ProviderQuotaExhaustedError } from "../quota/state.ts";
import { REAP_QUOTA_EXHAUSTED_KIND } from "../reap/quota.ts";
import { spawnRun } from "../spawn/index.ts";
import type { SpawnLogger, SpawnRunInput } from "../spawn/types.ts";
import type { BridgeRegistry } from "../stream/types.ts";
import { inheritedDispatchOverrides } from "./inherited-overrides.ts";

/** Event kinds this module writes. All but `spawnResume` go on the failed run. */
export const QUOTA_RESUME_EVENTS = {
	scheduled: "reap.quota_resume_scheduled",
	started: "reap.quota_resume_started",
	dispatched: "reap.quota_resume_dispatched",
	failed: "reap.quota_resume_failed",
	exhausted: "reap.quota_resume_exhausted",
	skipped: "reap.quota_resume_skipped",
	/** On the successor: it exists to resume `resumedFromRunId`. */
	spawnResume: "spawn.quota_resume",
} as const;

const DECISION_KINDS: readonly string[] = [
	QUOTA_RESUME_EVENTS.scheduled,
	QUOTA_RESUME_EVENTS.started,
	QUOTA_RESUME_EVENTS.dispatched,
	QUOTA_RESUME_EVENTS.failed,
	QUOTA_RESUME_EVENTS.exhausted,
	QUOTA_RESUME_EVENTS.skipped,
];

/** Resumes one lineage may hold. The run that first hit the limit is not one. */
export const MAX_QUOTA_RESUMES = 3;
/** Wait this long past the reset, so the provider's clock has surely rolled over. */
const RESUME_DELAY_SECONDS = 60;
/** Spread resumes on one credential over this many seconds after the delay. */
const RESUME_JITTER_SECONDS = 120;
/** How far back the tick looks. Covers a seven-day usage window plus a day. */
const RESUME_LOOKBACK_MS = 8 * 24 * 60 * 60 * 1000;

const PLAN_RUN_TRIGGERS: readonly string[] = ["plan-run", "auto_plan_run"];

type QuotaResumeMode = "continue" | "replicate";

type QuotaResumeSkip = "plan_run_child" | "no_project" | "reset_unknown";

export interface QuotaResumerInput {
	readonly repos: Repos;
	readonly runtimeProvider: RuntimeProvider;
	readonly bridges: Pick<BridgeRegistry, "start">;
	readonly projectsConfig: ProjectsConfig;
	readonly projectSpawn: ProjectSpawnFn;
	readonly forge?: Forge;
	readonly warrenConfigs?: WarrenConfigCache;
	readonly runBranchPrefixDefault?: string;
	readonly seedsCli?: SeedsCliDeps;
	readonly issueTracker?: IssueTracker;
	/** The env the stored quota window is keyed by. Defaults to `process.env`. */
	readonly serverEnv?: Readonly<Record<string, string | undefined>>;
	readonly broker?: RunEventBroker;
	readonly logger?: SpawnLogger;
	/** Test seam. Defaults to the live `spawnRun`. */
	readonly spawnRunFn?: typeof spawnRun;
	readonly now?: () => Date;
	/** Jitter source in [0, 1). Defaults to `Math.random`. */
	readonly random?: () => number;
}

export interface QuotaResumer {
	/** Decide whether a just-reaped run resumes, and record the decision. Never dispatches. */
	scheduleRun(runId: string): Promise<void>;
	/** Decide undecided candidates and dispatch every resume that is due. */
	tick(): Promise<void>;
}

interface ScheduledResume {
	readonly resumeAt: string;
	readonly resetsAt: number;
	readonly attempt: number;
	readonly mode: QuotaResumeMode;
}

export function createQuotaResumer(input: QuotaResumerInput): QuotaResumer {
	const now = input.now ?? (() => new Date());
	const random = input.random ?? Math.random;
	const emit = async (runId: string, kind: string, payload: unknown): Promise<void> => {
		const seq = ((await input.repos.events.maxSeqForRun(runId)) ?? 0) + 1;
		const row = await input.repos.events.append({
			runId,
			sandboxEventSeq: seq,
			ts: now().toISOString(),
			kind,
			stream: "system",
			payload,
		});
		input.broker?.publish(runId, row);
	};
	const resumeAtAfter = (resetsAtSeconds: number): string => {
		const jitter = Math.floor(random() * RESUME_JITTER_SECONDS);
		return new Date((resetsAtSeconds + RESUME_DELAY_SECONDS + jitter) * 1000).toISOString();
	};

	const decide = async (run: RunRow, events: readonly EventRow[]): Promise<void> => {
		const skip = async (reason: QuotaResumeSkip) => {
			input.logger?.info({ runId: run.id, reason }, "quota-resume.skipped");
			await emit(run.id, QUOTA_RESUME_EVENTS.skipped, { reason });
		};
		if (PLAN_RUN_TRIGGERS.includes(run.trigger)) return skip("plan_run_child");
		if ((await input.repos.planRuns.findChildByRunId(run.id)) !== null) {
			return skip("plan_run_child");
		}
		if (run.projectId === null) return skip("no_project");
		const attempts = await countQuotaResumes(input.repos, run, events);
		if (attempts >= MAX_QUOTA_RESUMES) {
			input.logger?.info({ runId: run.id, attempts }, "quota-resume.exhausted");
			await emit(run.id, QUOTA_RESUME_EVENTS.exhausted, {
				attempts,
				maxAttempts: MAX_QUOTA_RESUMES,
			});
			return;
		}
		const resetsAt = await resolveResetsAt(input, run, events);
		if (resetsAt === null) return skip("reset_unknown");
		const scheduled: ScheduledResume = {
			resumeAt: resumeAtAfter(resetsAt),
			resetsAt,
			attempt: attempts + 1,
			mode: resumeMode(run),
		};
		input.logger?.info({ runId: run.id, ...scheduled }, "quota-resume.scheduled");
		await emit(run.id, QUOTA_RESUME_EVENTS.scheduled, {
			...scheduled,
			maxAttempts: MAX_QUOTA_RESUMES,
		});
	};

	const dispatch = async (run: RunRow, scheduled: ScheduledResume): Promise<void> => {
		await emit(run.id, QUOTA_RESUME_EVENTS.started, { attempt: scheduled.attempt });
		try {
			const result = await (input.spawnRunFn ?? spawnRun)(
				await buildResumeSpawnInput(input, now, run, scheduled.mode),
			);
			// Stamp first: the stamp is the lineage's attempt count, so it must
			// be on the successor before the successor can reap.
			await emit(result.run.id, QUOTA_RESUME_EVENTS.spawnResume, {
				resumedFromRunId: run.id,
				attempt: scheduled.attempt,
				mode: scheduled.mode,
			});
			input.bridges.start(result.run.id, result.sandboxRun.id, result.sandbox.id, result.run.mode);
			await emit(run.id, QUOTA_RESUME_EVENTS.dispatched, {
				newRunId: result.run.id,
				attempt: scheduled.attempt,
				mode: scheduled.mode,
			});
			input.logger?.info({ runId: run.id, newRunId: result.run.id }, "quota-resume.dispatched");
		} catch (err) {
			if (err instanceof ProviderQuotaExhaustedError) {
				// The window moved: wait for the new reset, same attempt.
				const resetsAt = Math.ceil(now().getTime() / 1000) + err.retryAfterSeconds;
				await emit(run.id, QUOTA_RESUME_EVENTS.scheduled, {
					...scheduled,
					resetsAt,
					resumeAt: resumeAtAfter(resetsAt),
					maxAttempts: MAX_QUOTA_RESUMES,
				});
				return;
			}
			const error = err instanceof Error ? err.message : String(err);
			input.logger?.error({ runId: run.id, error }, "quota-resume.failed");
			await emit(run.id, QUOTA_RESUME_EVENTS.failed, { error });
		}
	};

	/** Dispatch a due resume, under the automatic-run cap when the run came from one. */
	const dispatchWhenAdmitted = async (run: RunRow, scheduled: ScheduledResume): Promise<void> => {
		if (!isAutomaticRunTrigger(run.trigger)) return dispatch(run, scheduled);
		// Not admitted: the resume stays scheduled and the next tick tries again.
		await withAutomaticRunAdmission(input.repos.runs, () => dispatch(run, scheduled), now());
	};

	const advance = async (run: RunRow, decisions: readonly EventRow[]): Promise<void> => {
		const last = decisions.at(-1);
		if (last === undefined) {
			await decide(run, await input.repos.events.listByRun(run.id));
			return;
		}
		if (last.kind === QUOTA_RESUME_EVENTS.started) {
			await emit(run.id, QUOTA_RESUME_EVENTS.failed, {
				error: "the control plane stopped while it was dispatching this resume",
			});
			return;
		}
		if (last.kind !== QUOTA_RESUME_EVENTS.scheduled) return;
		const scheduled = readScheduled(last.payloadJson);
		if (scheduled === null) {
			await emit(run.id, QUOTA_RESUME_EVENTS.failed, {
				error: "the resume schedule is unreadable",
			});
			return;
		}
		if (Date.parse(scheduled.resumeAt) > now().getTime()) return;
		await dispatchWhenAdmitted(run, scheduled);
	};

	return {
		async scheduleRun(runId) {
			const run = await input.repos.runs.get(runId);
			if (run === null || !isQuotaExhausted(run)) return;
			const events = await input.repos.events.listByRun(runId);
			if (events.some((e) => DECISION_KINDS.includes(e.kind))) return;
			await decide(run, events);
		},
		async tick() {
			const since = new Date(now().getTime() - RESUME_LOOKBACK_MS).toISOString();
			const candidates = await input.repos.runs.listFailedSince("quota_exhausted", since);
			if (candidates.length === 0) return;
			const decisions = await input.repos.events.listEventsByKindsForRuns(
				candidates.map((r) => r.id),
				DECISION_KINDS,
			);
			for (const run of candidates) {
				const own = decisions
					.filter((e) => e.runId === run.id)
					.sort((a, b) => a.sandboxEventSeq - b.sandboxEventSeq);
				try {
					await advance(run, own);
				} catch (err) {
					const error = err instanceof Error ? err.message : String(err);
					input.logger?.error({ runId: run.id, error }, "quota-resume.tick_failed");
				}
			}
		},
	};
}

function isFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

function isQuotaExhausted(run: RunRow): boolean {
	return run.state === "failed" && run.failureReason === "quota_exhausted";
}

/** `continue` when the stopped run pushed commits, so the resume builds on them. */
function resumeMode(run: RunRow): QuotaResumeMode {
	return (run.commitsAhead ?? 0) > 0 ? "continue" : "replicate";
}

/**
 * Where the successor starts and pushes. `runs.branch` is the branch the
 * stopped run actually pushed to, so the resume reads it rather than
 * recomposing a name.
 *
 * - An operator target branch: dispatch onto it again, as the stopped run was.
 * - Commits on the run's own composed branch: a `continue` clone of it.
 * - Commits on a `newBranch` name: a clone cut from that branch.
 * - Nothing pushed: the stopped run's config again, from the same base.
 */
function resumeBase(run: RunRow): Partial<SpawnRunInput> {
	const pinned = {
		...(run.ref !== null ? { ref: run.ref } : {}),
		...(run.baseCommit !== null ? { baseCommit: run.baseCommit } : {}),
	};
	if (run.targetBranch !== null) return { ...pinned, targetBranch: run.targetBranch };
	if (resumeMode(run) === "continue" && run.branch !== null) {
		if (run.branch.endsWith(`/${run.id}`)) return { parentRunId: run.id, cloneKind: "continue" };
		return { parentRunId: run.id, cloneKind: "replicate", ref: run.branch };
	}
	return { ...pinned, parentRunId: run.id, cloneKind: "replicate" };
}

function readScheduled(payload: unknown): ScheduledResume | null {
	const p = payload as Partial<Record<keyof ScheduledResume, unknown>> | null;
	if (p === null || typeof p !== "object") return null;
	if (typeof p.resumeAt !== "string" || Number.isNaN(Date.parse(p.resumeAt))) return null;
	if (!isFiniteNumber(p.resetsAt) || !isFiniteNumber(p.attempt)) return null;
	return {
		resumeAt: p.resumeAt,
		resetsAt: p.resetsAt,
		attempt: p.attempt,
		mode: p.mode === "continue" ? "continue" : "replicate",
	};
}

/**
 * The reset this run waits for: the one on its `reap.quota_exhausted` event,
 * else the stored window of the credential it ran on while that is rejected.
 */
async function resolveResetsAt(
	input: QuotaResumerInput,
	run: RunRow,
	events: readonly EventRow[],
): Promise<number | null> {
	for (const event of [...events].reverse()) {
		if (event.kind !== REAP_QUOTA_EXHAUSTED_KIND) continue;
		const resetsAt = (event.payloadJson as { resetsAt?: unknown } | null)?.resetsAt;
		if (typeof resetsAt === "number" && Number.isFinite(resetsAt)) return resetsAt;
		break;
	}
	const key = quotaKey({ provider: run.provider, env: input.serverEnv ?? process.env });
	const stored = await input.repos.providerQuota.get(key.provider, key.credentialFingerprint);
	if (stored === undefined) return null;
	// A window no longer rejected has reset already: resume now.
	if (stored.status !== "rejected")
		return Math.floor((input.now?.() ?? new Date()).getTime() / 1000);
	return stored.resetsAt;
}

/**
 * Resumes already spent by this lineage, walking back from `failed`. A run
 * stamped `spawn.quota_resume` counts one and leads to the run it resumed;
 * an unstamped run leads on through `retryOf` (an infra-lost retry in the
 * middle of the chain) or ends the walk.
 */
async function countQuotaResumes(
	repos: Repos,
	failed: RunRow,
	failedEvents: readonly EventRow[],
): Promise<number> {
	let attempts = 0;
	let current: RunRow | null = failed;
	let events: readonly EventRow[] = failedEvents;
	const seen = new Set<string>([failed.id]);
	while (current !== null && attempts < MAX_QUOTA_RESUMES) {
		const stamp = events.find((e) => e.kind === QUOTA_RESUME_EVENTS.spawnResume);
		const resumedFrom = (stamp?.payloadJson as { resumedFromRunId?: unknown } | undefined)
			?.resumedFromRunId;
		if (stamp !== undefined) attempts += 1;
		const parentId = typeof resumedFrom === "string" ? resumedFrom : current.retryOf;
		if (parentId === null || seen.has(parentId)) break;
		seen.add(parentId);
		current = await repos.runs.get(parentId);
		events = current === null ? [] : await repos.events.listByRun(parentId);
	}
	return attempts;
}

function resumePrompt(run: RunRow, mode: QuotaResumeMode): string {
	if (mode === "replicate") return run.prompt;
	return (
		`Run ${run.id} worked on this task and stopped when the provider's usage limit ` +
		"was reached. Its commits are on this branch. Read what it already did, then " +
		`finish the task.\n\n${run.prompt}`
	);
}

async function buildResumeSpawnInput(
	input: QuotaResumerInput,
	now: () => Date,
	run: RunRow,
	mode: QuotaResumeMode,
): Promise<SpawnRunInput> {
	const projectId = run.projectId;
	if (projectId === null) throw new Error(`run ${run.id} no longer belongs to a project`);
	const project = await input.repos.projects.get(projectId);
	const gitCredential =
		input.forge !== undefined && project !== null
			? await mintGitCredential(input.forge, project.gitUrl)
			: undefined;
	return {
		repos: input.repos,
		runtimeProvider: input.runtimeProvider,
		agentName: run.agentName,
		projectId,
		prompt: resumePrompt(run, mode),
		trigger: run.trigger,
		dispatchOrigin: "resume_quota",
		...(run.seedId !== null ? { seedId: run.seedId } : {}),
		mode: run.mode,
		// warren-0d80: run on the provider, model and caps the stopped run resolved.
		...inheritedDispatchOverrides(run.renderedAgentJson),
		...resumeBase(run),
		projectsConfig: input.projectsConfig,
		projectSpawn: input.projectSpawn,
		...(gitCredential !== undefined ? { gitCredential } : {}),
		...(input.warrenConfigs !== undefined ? { warrenConfigs: input.warrenConfigs } : {}),
		...(input.runBranchPrefixDefault !== undefined
			? { runBranchPrefixDefault: input.runBranchPrefixDefault }
			: {}),
		...(input.seedsCli !== undefined ? { seedsCli: input.seedsCli } : {}),
		...(input.issueTracker !== undefined ? { issueTracker: input.issueTracker } : {}),
		...(input.serverEnv !== undefined ? { serverEnv: input.serverEnv } : {}),
		...(input.logger !== undefined ? { logger: input.logger } : {}),
		now,
	};
}

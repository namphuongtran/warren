/**
 * The quota hold releaser (namphuongtran/warren#30).
 *
 * `spawnOrHoldRun` parks a dispatch the provider-quota guard refused as a
 * `queued` run with no workload and a `dispatch.quota_held` event
 * (`./hold.ts`). Each tick looks at the runs still waiting and launches the
 * ones whose `releaseAt` has passed, one at a time, as the same row:
 *
 * | Newest hold event | What the tick does |
 * |---|---|
 * | none | nothing: a queued row mid-spawn, not a hold |
 * | `held`, before `releaseAt` | nothing |
 * | `held`, due | claims it (`releasing`), then launches it |
 * | `releasing` | the control plane stopped mid-launch: fails the row |
 *
 * The `releasing` claim goes on the stream before the launch, so a restart
 * mid-launch fails the run instead of launching it twice. A launch the guard
 * still refuses (a newer report moved the reset) is held again at the new
 * reset. A run the operator cancelled is no longer `queued`, so it is never
 * launched. Any other launch failure fails the row `never_started`, the same
 * as a failed spawn.
 */

import { QUOTA_HOLD_EVENTS } from "../../core/wire.ts";
import type { EventRow, RunRow } from "../../db/schema.ts";
import { mintGitCredential } from "../../forge/credentials.ts";
import { inheritedDispatchOverrides } from "../retry/inherited-overrides.ts";
import type { QuotaResumerInput } from "../retry/quota-resume.ts";
import { launchHeldRun } from "../spawn/index.ts";
import type { SpawnRunInput } from "../spawn/types.ts";
import { appendRunSystemEvent } from "../stream/system-event.ts";
import {
	type HeldDecision,
	type HeldDispatchRequest,
	HeldRunNotPendingError,
	isHeldRunPending,
	newestHoldEventByRun,
	QUOTA_HOLD_KINDS,
	readHeldDecision,
	recordQuotaHold,
} from "./hold.ts";
import { ProviderQuotaExhaustedError } from "./state.ts";

/**
 * The resumer's dispatch deps. The clone refresh seams stay optional here, as
 * on `spawnRun` itself: without them the launch skips the refresh.
 */
export type QuotaHoldReleaserInput = Omit<
	QuotaResumerInput,
	"projectsConfig" | "projectSpawn" | "spawnRunFn"
> &
	Partial<Pick<QuotaResumerInput, "projectsConfig" | "projectSpawn">>;

export interface QuotaHoldReleaser {
	/** Launch every held run whose release time has passed. */
	tick(): Promise<void>;
}

export function createQuotaHoldReleaser(input: QuotaHoldReleaserInput): QuotaHoldReleaser {
	const now = input.now ?? (() => new Date());
	const emit = async (runId: string, kind: string, payload: unknown): Promise<void> => {
		const ts = now().toISOString();
		await appendRunSystemEvent(input.repos, input.broker, { runId, kind, payload, ts });
	};

	/** Fail a held row that can no longer be launched. */
	const failHeld = async (run: RunRow, error: string): Promise<void> => {
		input.logger?.error({ runId: run.id, error }, "quota-hold.release_failed");
		const at = now();
		await input.repos.runs.markRunning(run.id, at);
		await input.repos.runs.finalize(run.id, "failed", at, "never_started");
		await emit(run.id, QUOTA_HOLD_EVENTS.releaseFailed, { error });
	};

	const release = async (run: RunRow, held: HeldDecision): Promise<void> => {
		await emit(run.id, QUOTA_HOLD_EVENTS.releasing, {});
		try {
			const result = await launchHeldRun(
				await buildLaunchInput(input, now, run, held.request),
				run.id,
			);
			input.bridges.start(result.run.id, result.sandboxRun.id, result.sandbox.id, result.run.mode);
			await emit(run.id, QUOTA_HOLD_EVENTS.released, { sandboxId: result.sandbox.id });
			input.logger?.info({ runId: run.id }, "quota-hold.released");
		} catch (err) {
			await onReleaseError(run, held, err);
		}
	};

	const onReleaseError = async (run: RunRow, held: HeldDecision, err: unknown): Promise<void> => {
		if (err instanceof ProviderQuotaExhaustedError) {
			// The window moved: wait for the new reset.
			await recordQuotaHold(input.repos, {
				runId: run.id,
				request: held.request,
				resetsAt: err.resetsAt,
				now: now(),
				...(input.random !== undefined ? { random: input.random } : {}),
				...(input.broker !== undefined ? { broker: input.broker } : {}),
			});
			return;
		}
		const error = err instanceof Error ? err.message : String(err);
		if (err instanceof HeldRunNotPendingError) {
			input.logger?.info({ runId: run.id, error }, "quota-hold.no_longer_held");
			return;
		}
		// launchHeldRun already failed the row; record why on the hold.
		input.logger?.error({ runId: run.id, error }, "quota-hold.release_failed");
		await emit(run.id, QUOTA_HOLD_EVENTS.releaseFailed, { error });
	};

	const advance = async (run: RunRow, last: EventRow | undefined): Promise<void> => {
		if (last === undefined) return;
		if (last.kind === QUOTA_HOLD_EVENTS.releasing) {
			return failHeld(run, "the control plane stopped while it was launching this held run");
		}
		if (last.kind !== QUOTA_HOLD_EVENTS.held) return;
		const held = readHeldDecision(last.payloadJson);
		if (held === null) return failHeld(run, "the held dispatch request is unreadable");
		if (Date.parse(held.releaseAt) > now().getTime()) return;
		await release(run, held);
	};

	return {
		async tick() {
			const queued = await input.repos.runs.listByState("queued");
			const candidates = queued
				.filter(isHeldRunPending)
				.sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
			if (candidates.length === 0) return;
			const newest = newestHoldEventByRun(
				await input.repos.events.listEventsByKindsForRuns(
					candidates.map((r) => r.id),
					QUOTA_HOLD_KINDS,
				),
			);
			for (const run of candidates) {
				try {
					await advance(run, newest.get(run.id));
				} catch (err) {
					const error = err instanceof Error ? err.message : String(err);
					input.logger?.error({ runId: run.id, error }, "quota-hold.tick_failed");
				}
			}
		},
	};
}

/** The held request replayed on the row's frozen config, this process's deps and a fresh git credential. */
async function buildLaunchInput(
	input: QuotaHoldReleaserInput,
	now: () => Date,
	run: RunRow,
	request: HeldDispatchRequest,
): Promise<SpawnRunInput> {
	const project = await input.repos.projects.get(request.projectId);
	const gitCredential =
		input.forge !== undefined && project !== null
			? await mintGitCredential(input.forge, project.gitUrl)
			: undefined;
	return {
		...request,
		// The row froze the provider, model and caps when the run was held, so
		// a later agent or project-default edit cannot change what it runs on.
		...inheritedDispatchOverrides(run.renderedAgentJson),
		repos: input.repos,
		runtimeProvider: input.runtimeProvider,
		...(input.projectsConfig !== undefined ? { projectsConfig: input.projectsConfig } : {}),
		...(input.projectSpawn !== undefined ? { projectSpawn: input.projectSpawn } : {}),
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

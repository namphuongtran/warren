/**
 * The two drivers of the quota auto-resume (namphuongtran/warren#30 Phase 2):
 * a `post_reap` lifecycle consumer that records the decision as soon as a run
 * reaps `quota_exhausted`, and an interval worker that runs the resumer's
 * tick. The worker is what dispatches, so it is also what makes a pending
 * resume survive a restart. The policy lives in `./quota-resume.ts`.
 */

import { type LifecycleExtension, WARREN_EXT_PROTOCOL } from "../lifecycle-bus.ts";
import type { SpawnLogger } from "../spawn/types.ts";
import type { QuotaResumer } from "./quota-resume.ts";

/** How often the worker ticks. A resume carries up to two minutes of jitter anyway. */
const QUOTA_RESUME_TICK_MS = 60_000;

export function createQuotaResumeLifecycleExtension(resumer: QuotaResumer): LifecycleExtension {
	return {
		name: "quota-resume",
		protocol: WARREN_EXT_PROTOCOL,
		hooks: {
			post_reap: async (envelope) => {
				if (envelope.payload.outcome !== "failed") return;
				await resumer.scheduleRun(envelope.payload.runId);
			},
		},
	};
}

export interface QuotaResumeWorkerHandle {
	/** Stop ticking and wait for a tick in flight, so no dispatch outlives teardown. */
	stop(): Promise<void>;
}

interface StartQuotaResumeWorkerInput {
	/** Anything that ticks: the resumer, or the quota hold releaser (namphuongtran/warren#30). */
	readonly resumer: Pick<QuotaResumer, "tick">;
	readonly logger?: SpawnLogger;
	/** Log name of a failed tick. Defaults to `quota-resume`. */
	readonly name?: string;
}

/** Single-flight: a tick still running when the next interval fires is skipped. */
export function startQuotaResumeWorker(
	input: StartQuotaResumeWorkerInput,
): QuotaResumeWorkerHandle {
	let inFlight: Promise<void> | null = null;
	let stopped = false;
	const fire = (): void => {
		if (stopped || inFlight !== null) return;
		inFlight = input.resumer
			.tick()
			.catch((err: unknown) => {
				const error = err instanceof Error ? err.message : String(err);
				input.logger?.error({ error }, `${input.name ?? "quota-resume"}.tick_failed`);
			})
			.finally(() => {
				inFlight = null;
			});
	};
	const timer = setInterval(fire, QUOTA_RESUME_TICK_MS);
	return {
		async stop() {
			stopped = true;
			clearInterval(timer);
			await inFlight;
		},
	};
}

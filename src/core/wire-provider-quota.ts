/**
 * Provider usage-window state vocabulary (namphuongtran/warren#30). Re-exported
 * by `src/core/wire.ts` so the canonical import path stays `src/core/wire.ts`.
 */

/**
 * Where a quota row's newest report came from. `rate_limit_event` — the
 * harness reported the window mid-run (the stream bridge). `reap` — a run
 * reaped `quota_exhausted` (namphuongtran/warren#74).
 */
export const PROVIDER_QUOTA_SOURCES = ["rate_limit_event", "reap"] as const;
export type ProviderQuotaSource = (typeof PROVIDER_QUOTA_SOURCES)[number];

/**
 * The window status that refuses dispatch. The provider owns the full set
 * (claude reports `allowed`, `allowed_warning`, `rejected`), so `status`
 * stays an open string. Warren refuses dispatch on this value.
 */
export const PROVIDER_QUOTA_REJECTED = "rejected";

/** The window status the provider reports when the window is nearly spent. Shown, not acted on. */
export const PROVIDER_QUOTA_WARNING = "allowed_warning";

/** The machine-readable reason of a dispatch refused on a spent usage window. */
export const PROVIDER_QUOTA_EXHAUSTED = "provider_quota_exhausted";

/**
 * One row of `GET /provider-quota`: the newest usage-window report for one
 * (provider, credential). `credentialFingerprint` is a one-way hash; the
 * credential itself never leaves the server.
 */
export interface ProviderQuotaView {
	readonly provider: string;
	readonly credentialFingerprint: string;
	/** The provider's verdict: `allowed`, `allowed_warning` or `rejected`. */
	readonly status: string;
	/** Share of the binding window spent, 0..1, when reported. */
	readonly utilization: number | null;
	/** Which window binds (e.g. `five_hour`), when reported. */
	readonly rateLimitType: string | null;
	/** When the window reopens, unix seconds, when reported. */
	readonly resetsAt: number | null;
	readonly source: ProviderQuotaSource;
	/** The run whose report this is, when one is known. */
	readonly sourceRunId: string | null;
	/** ISO8601 time of the report. */
	readonly observedAt: string;
	/** True while `status` is `rejected` and `resetsAt` is still ahead: dispatch is refused. */
	readonly exhausted: boolean;
	/**
	 * The deployment's dispatch threshold (`WARREN_PROVIDER_QUOTA_MAX_UTILIZATION`),
	 * or null when it is off. A project's `admission.maxProviderUtilization`
	 * can override it for that project's dispatches.
	 */
	readonly maxUtilization: number | null;
	/** True while the window is not spent but `utilization` is at or past `maxUtilization`. */
	readonly thresholdReached: boolean;
	/** Seconds until `resetsAt` while dispatch is refused (exhausted or threshold), else null. */
	readonly retryAfterSeconds: number | null;
}

export interface ListProviderQuotaResponse {
	readonly quotas: readonly ProviderQuotaView[];
}

/**
 * What `POST /runs` does when the provider-quota guard refuses the dispatch
 * (`onQuotaExhausted`). `refuse` (the default) answers 429. `hold` creates
 * the run `queued` with no workload and launches it after the window resets.
 */
export const QUOTA_EXHAUSTED_ACTIONS = ["refuse", "hold"] as const;
export type QuotaExhaustedAction = (typeof QUOTA_EXHAUSTED_ACTIONS)[number];

/**
 * The events that carry a held run's state, all on the held run. The newest
 * one says where the hold stands: `held` waits for `releaseAt`, `releasing`
 * means a launch began, `released` and `releaseFailed` are done.
 */
export const QUOTA_HOLD_EVENTS = {
	held: "dispatch.quota_held",
	releasing: "dispatch.quota_release_started",
	released: "dispatch.quota_released",
	releaseFailed: "dispatch.quota_release_failed",
} as const;

/** Why and until when a held run waits. On the 202 of a held `POST /runs`. */
export interface QuotaHoldView {
	readonly reason: typeof PROVIDER_QUOTA_EXHAUSTED;
	/** When the credential's window reopens, unix seconds. */
	readonly resetsAt: number;
	/** ISO8601 time the run is launched: the reset plus a short delay and jitter. */
	readonly releaseAt: string;
}

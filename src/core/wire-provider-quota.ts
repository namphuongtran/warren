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
 * stays an open string; this is the one value Warren acts on.
 */
export const PROVIDER_QUOTA_REJECTED = "rejected";

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
	/** Seconds until `resetsAt` while exhausted, else null. */
	readonly retryAfterSeconds: number | null;
}

export interface ListProviderQuotaResponse {
	readonly quotas: readonly ProviderQuotaView[];
}

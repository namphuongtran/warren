/**
 * Provider quota state and the dispatch guard (namphuongtran/warren#30).
 *
 * Harnesses report the provider's usage window as they run (claude-code's
 * `rate_limit_event`, read by the adapter hook `observeQuota`), and reap
 * reports a run the provider refused (`quota_exhausted`, #74). Both land
 * here, keyed by (provider, one-way credential fingerprint). `spawnRun` reads
 * the same key before it creates a run row: while the window is `rejected`
 * and `resetsAt` is ahead, the dispatch is refused with 429
 * `provider_quota_exhausted` and a `Retry-After` that ends at the reset.
 * Once `resetsAt` passes, dispatch opens again with no new report and no
 * restart. `force` lets an operator dispatch anyway.
 *
 * An optional utilization threshold (`maxUtilization`, default off) refuses
 * new dispatches the same way once the reported share of the window reaches
 * it, so runs already in flight keep the rest of the window.
 */

import {
	PROVIDER_QUOTA_EXHAUSTED,
	PROVIDER_QUOTA_REJECTED,
	type ProviderQuotaSource,
	type ProviderQuotaView,
} from "../../core/wire.ts";
import type { Repos } from "../../db/repos/index.ts";
import type { ProviderQuotaRow } from "../../db/schema.ts";
import type { QuotaObservation } from "../../runtime/adapters/index.ts";
import { RuntimeAdmissionError } from "../../runtime/errors.ts";
import { type QuotaCredentialInput, quotaKey } from "./fingerprint.ts";

type QuotaRepos = Pick<Repos, "providerQuota">;

/** The dispatch was refused because the credential's usage window is spent. */
export class ProviderQuotaExhaustedError extends RuntimeAdmissionError {
	override readonly code = PROVIDER_QUOTA_EXHAUSTED;
	/** When the window reopens, unix seconds, exactly as the stored report says. */
	readonly resetsAt: number;

	constructor(
		message: string,
		options: ConstructorParameters<typeof RuntimeAdmissionError>[1] & { resetsAt: number },
	) {
		super(message, options);
		this.resetsAt = options.resetsAt;
	}
}

export interface RecordQuotaObservationInput {
	readonly credential: QuotaCredentialInput;
	readonly observation: QuotaObservation;
	readonly source: ProviderQuotaSource;
	readonly sourceRunId: string | null;
	/** ISO8601. The newest report per credential wins. */
	readonly observedAt: string;
}

export async function recordQuotaObservation(
	repos: QuotaRepos,
	input: RecordQuotaObservationInput,
): Promise<void> {
	const { observation } = input;
	await repos.providerQuota.record({
		...quotaKey(input.credential),
		status: observation.status,
		utilization: observation.utilization,
		rateLimitType: observation.rateLimitType,
		resetsAt: observation.resetsAt,
		source: input.source,
		sourceRunId: input.sourceRunId,
		observedAt: input.observedAt,
	});
}

/** Seconds until the window resets while the reset is still ahead, else `null`. */
function secondsUntilWindowReset(row: ProviderQuotaRow, now: Date): number | null {
	if (row.resetsAt === null) return null;
	const seconds = Math.ceil(row.resetsAt - now.getTime() / 1000);
	return seconds > 0 ? seconds : null;
}

const percent = (share: number): string => `${Math.round(share * 100)}%`;

interface QuotaRefusal {
	readonly retryAfterSeconds: number;
	/** `spent`: the provider rejected the window. `threshold`: utilization reached the threshold. */
	readonly kind: "spent" | "threshold";
	readonly why: string;
}

/** Why the stored window refuses a new dispatch now, or `null` when it does not. */
function refusalReason(
	row: ProviderQuotaRow,
	now: Date,
	maxUtilization: number | undefined,
): QuotaRefusal | null {
	const retryAfterSeconds = secondsUntilWindowReset(row, now);
	if (retryAfterSeconds === null) return null;
	if (row.status === PROVIDER_QUOTA_REJECTED) {
		return { retryAfterSeconds, kind: "spent", why: "is spent" };
	}
	if (maxUtilization === undefined || row.utilization === null) return null;
	if (row.utilization < maxUtilization) return null;
	const why = `is ${percent(row.utilization)} used, at or past the ${percent(maxUtilization)} dispatch threshold`;
	return { retryAfterSeconds, kind: "threshold", why };
}

/** Deployment default for the dispatch utilization threshold: a share, 0 < x <= 1. */
export const PROVIDER_QUOTA_MAX_UTILIZATION_ENV = "WARREN_PROVIDER_QUOTA_MAX_UTILIZATION";

/** The threshold in force: the project's, else a valid deployment share, else off. */
export function resolveMaxUtilization(
	projectValue: number | undefined,
	env: Readonly<Record<string, string | undefined>>,
): number | undefined {
	if (projectValue !== undefined) return projectValue;
	const raw = env[PROVIDER_QUOTA_MAX_UTILIZATION_ENV]?.trim();
	if (raw === undefined || raw === "") return undefined;
	const share = Number(raw);
	return Number.isFinite(share) && share > 0 && share <= 1 ? share : undefined;
}

export interface AssertProviderQuotaOpenInput {
	readonly credential: QuotaCredentialInput;
	readonly now: Date;
	/** Operator override: dispatch even into a spent window. */
	readonly force?: boolean;
	/**
	 * Refuse while the window's reported utilization (0..1) is at or past this
	 * share, until the reset. Unset leaves only a rejected window refused.
	 */
	readonly maxUtilization?: number;
}

/** Throw {@link ProviderQuotaExhaustedError} while the credential's window is spent. */
export async function assertProviderQuotaOpen(
	repos: QuotaRepos,
	input: AssertProviderQuotaOpenInput,
): Promise<void> {
	if (input.force === true) return;
	const key = quotaKey(input.credential);
	const row = await repos.providerQuota.get(key.provider, key.credentialFingerprint);
	const refusal = row === undefined ? null : refusalReason(row, input.now, input.maxUtilization);
	if (row === undefined || refusal === null) return;
	const resetsAtSeconds = row.resetsAt ?? 0;
	const resetsAt = new Date(resetsAtSeconds * 1000).toISOString();
	const window = row.rateLimitType ?? "usage";
	throw new ProviderQuotaExhaustedError(
		`the ${key.provider} credential's ${window} window ${refusal.why} until ${resetsAt}`,
		{
			reason: PROVIDER_QUOTA_EXHAUSTED,
			retryAfterSeconds: refusal.retryAfterSeconds,
			resetsAt: resetsAtSeconds,
			recoveryHint: `retry after ${resetsAt}, or dispatch with force: true to run anyway`,
		},
	);
}

/**
 * Every credential's newest report, with whether dispatch is refused now
 * under `maxUtilization` (the deployment threshold; a project may override it).
 */
export async function listProviderQuota(
	repos: QuotaRepos,
	now: Date,
	maxUtilization?: number,
): Promise<ProviderQuotaView[]> {
	const rows = await repos.providerQuota.list();
	return rows.map((row) => {
		const refusal = refusalReason(row, now, maxUtilization);
		return {
			provider: row.provider,
			credentialFingerprint: row.credentialFingerprint,
			status: row.status,
			utilization: row.utilization,
			rateLimitType: row.rateLimitType,
			resetsAt: row.resetsAt,
			source: row.source,
			sourceRunId: row.sourceRunId,
			observedAt: row.observedAt,
			exhausted: refusal?.kind === "spent",
			maxUtilization: maxUtilization ?? null,
			thresholdReached: refusal?.kind === "threshold",
			retryAfterSeconds: refusal?.retryAfterSeconds ?? null,
		};
	});
}

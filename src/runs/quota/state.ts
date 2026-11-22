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

/** Seconds until the window reopens while it is rejected, else `null`. */
function secondsUntilReset(row: ProviderQuotaRow, now: Date): number | null {
	if (row.status !== PROVIDER_QUOTA_REJECTED || row.resetsAt === null) return null;
	const seconds = Math.ceil(row.resetsAt - now.getTime() / 1000);
	return seconds > 0 ? seconds : null;
}

export interface AssertProviderQuotaOpenInput {
	readonly credential: QuotaCredentialInput;
	readonly now: Date;
	/** Operator override: dispatch even into a spent window. */
	readonly force?: boolean;
}

/** Throw {@link ProviderQuotaExhaustedError} while the credential's window is spent. */
export async function assertProviderQuotaOpen(
	repos: QuotaRepos,
	input: AssertProviderQuotaOpenInput,
): Promise<void> {
	if (input.force === true) return;
	const key = quotaKey(input.credential);
	const row = await repos.providerQuota.get(key.provider, key.credentialFingerprint);
	const retryAfterSeconds = row === undefined ? null : secondsUntilReset(row, input.now);
	if (row === undefined || retryAfterSeconds === null) return;
	const resetsAt = new Date((row.resetsAt ?? 0) * 1000).toISOString();
	const window = row.rateLimitType ?? "usage";
	throw new ProviderQuotaExhaustedError(
		`the ${key.provider} credential's ${window} window is spent until ${resetsAt}`,
		{
			reason: PROVIDER_QUOTA_EXHAUSTED,
			retryAfterSeconds,
			recoveryHint: `retry after ${resetsAt}, or dispatch with force: true to run anyway`,
		},
	);
}

/** Every credential's newest report, with whether dispatch is refused now. */
export async function listProviderQuota(
	repos: QuotaRepos,
	now: Date,
): Promise<ProviderQuotaView[]> {
	const rows = await repos.providerQuota.list();
	return rows.map((row) => {
		const retryAfterSeconds = secondsUntilReset(row, now);
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
			exhausted: retryAfterSeconds !== null,
			retryAfterSeconds,
		};
	});
}

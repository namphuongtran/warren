/**
 * The one-way credential fingerprint that keys the provider quota state
 * (namphuongtran/warren#30).
 *
 * Two runs share a usage window exactly when they authenticate with the same
 * credential, so the state is keyed by the credential. The secret itself must
 * never reach the database, the events or the API, so the key is a truncated,
 * domain-separated SHA-256 of it. 64 bits tell credentials apart on one
 * instance; a provider token is far too long and random for the hash to be
 * reversed by guessing.
 */

import { createHash } from "node:crypto";
import { resolveProviderCredential } from "../../core/providers.ts";

/** The fingerprint of "this process holds no credential for the provider". */
export const UNRESOLVED_CREDENTIAL = "unresolved";

const DOMAIN = "warren-provider-quota/v1";
const FINGERPRINT_HEX_CHARS = 16;

/** What a quota read or write names: the run's declared provider and the env it dispatches with. */
export interface QuotaCredentialInput {
	readonly provider: string | null | undefined;
	readonly env: Readonly<Record<string, string | undefined>>;
}

export interface QuotaKey {
	readonly provider: string;
	readonly credentialFingerprint: string;
}

export function quotaKey(input: QuotaCredentialInput): QuotaKey {
	const { provider, secret } = resolveProviderCredential(input.provider, input.env);
	if (secret === null) return { provider, credentialFingerprint: UNRESOLVED_CREDENTIAL };
	const digest = createHash("sha256").update(`${DOMAIN}\0${provider}\0${secret}`).digest("hex");
	return { provider, credentialFingerprint: digest.slice(0, FINGERPRINT_HEX_CHARS) };
}

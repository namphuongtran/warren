/**
 * Rejects only provider/model pairs known to be incompatible (warren-bad5).
 *
 * Unknown providers and ambiguous model identifiers remain valid because
 * provider and model names are intentionally open-ended. Known provider
 * names are normalized through the core registry (warren-fb8d) first, so a
 * casing variant of a registered provider hits the same checks.
 */

import { ValidationError } from "../../core/errors.ts";
import { normalizeProviderName } from "../../core/providers.ts";
import { resolveOverride } from "./agent-cache.ts";

function canonicalProvider(provider: string): string {
	// warren-fb8d: consult the core provider registry so casing variants of a
	// KNOWN provider ("OpenRouter") hit the same incompatibility checks as the
	// canonical spelling. Unknown providers stay open-ended and unchecked.
	return normalizeProviderName(provider) ?? provider;
}

function isKnownProviderModelMismatch(provider: string, model: string): boolean {
	const canonical = canonicalProvider(provider);
	const hasSlash = model.includes("/");
	const isSlashlessClaudeModel = !hasSlash && model.startsWith("claude-");
	return (
		(canonical === "openrouter" && isSlashlessClaudeModel) ||
		(canonical === "anthropic" && hasSlash)
	);
}

export function assertNoKnownProviderModelMismatch(
	provider: string | undefined,
	model: string | undefined,
): void {
	if (provider === undefined || model === undefined) return;
	if (!isKnownProviderModelMismatch(provider, model)) return;

	const expectedShape =
		canonicalProvider(provider) === "openrouter"
			? 'an OpenRouter model id in "vendor/model" form'
			: 'a slashless Anthropic model id such as "claude-opus-4-8"';
	throw new ValidationError(`model "${model}" is incompatible with provider "${provider}"`, {
		recoveryHint: `use ${expectedShape}, change the provider, or remove the incompatible provider/model setting`,
	});
}

/** The dispatch provider, plus the inherited one a model override dropped. */
export interface DispatchProviderChoice {
	readonly provider: string | undefined;
	readonly droppedProjectProvider?: string;
}

/**
 * Resolve the dispatch provider with the `resolveOverride` chain
 * (operator override > project default), with one exception
 * (namphuongtran/warren#43). A model-only override replaces the model of
 * the project's provider/model pair. An inherited project provider that is
 * known-incompatible with that model is dropped, so the provider falls
 * through to the agent frontmatter. An explicit operator provider is never
 * dropped: an explicit bad pair still fails the mismatch assertion.
 */
export function resolveDispatchProvider(
	overrides: { readonly providerOverride?: string; readonly modelOverride?: string },
	projectDefaultProvider: string | undefined,
): DispatchProviderChoice {
	const provider = resolveOverride(overrides.providerOverride, projectDefaultProvider);
	const isInherited = resolveOverride(overrides.providerOverride, undefined) === undefined;
	const model = resolveOverride(overrides.modelOverride, undefined);
	if (provider === undefined || !isInherited || model === undefined) return { provider };
	if (!isKnownProviderModelMismatch(provider, model)) return { provider };
	return { provider: undefined, droppedProjectProvider: provider };
}

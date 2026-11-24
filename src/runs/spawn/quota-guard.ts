/**
 * The dispatch side of the provider quota state (namphuongtran/warren#30).
 * `spawnRun` calls this once the provider override chain has resolved and
 * before it creates the run row, so a refusal leaves no row and no workload.
 * The credential resolves from the same env the run is dispatched with.
 *
 * The optional utilization threshold resolves here too: the project's
 * `admission.maxProviderUtilization`, else the deployment default in
 * {@link PROVIDER_QUOTA_MAX_UTILIZATION_ENV}, else off.
 */

import { assertProviderQuotaOpen } from "../quota/state.ts";
import type { PreparedDispatch } from "./prepare.ts";
import type { SpawnRunInput } from "./types.ts";

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

export async function assertDispatchQuotaOpen(
	input: SpawnRunInput,
	prepared: Pick<PreparedDispatch, "declaredProvider" | "projectDefaults">,
): Promise<void> {
	const env = input.serverEnv ?? process.env;
	const maxUtilization = resolveMaxUtilization(
		prepared.projectDefaults?.admission?.maxProviderUtilization,
		env,
	);
	await assertProviderQuotaOpen(input.repos, {
		credential: { provider: prepared.declaredProvider, env },
		now: input.now?.() ?? new Date(),
		...(input.force !== undefined ? { force: input.force } : {}),
		...(maxUtilization !== undefined ? { maxUtilization } : {}),
	});
}

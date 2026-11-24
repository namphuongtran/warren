/**
 * The dispatch side of the provider quota state (namphuongtran/warren#30).
 * `spawnRun` calls this once the provider override chain has resolved and
 * before it creates the run row, so a refusal leaves no row and no workload.
 * The credential resolves from the same env the run is dispatched with.
 *
 * The optional utilization threshold resolves here too: the project's
 * `admission.maxProviderUtilization`, else the deployment default in
 * `WARREN_PROVIDER_QUOTA_MAX_UTILIZATION`, else off (`resolveMaxUtilization`).
 */

import { assertProviderQuotaOpen, resolveMaxUtilization } from "../quota/state.ts";
import type { PreparedDispatch } from "./prepare.ts";
import type { SpawnRunInput } from "./types.ts";

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

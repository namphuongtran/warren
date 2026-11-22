/**
 * The dispatch side of the provider quota state (namphuongtran/warren#30).
 * `spawnRun` calls this once the provider override chain has resolved and
 * before it creates the run row, so a refusal leaves no row and no workload.
 * The credential resolves from the same env the run is dispatched with.
 */

import { assertProviderQuotaOpen } from "../quota/state.ts";
import type { SpawnRunInput } from "./types.ts";

export async function assertDispatchQuotaOpen(
	input: SpawnRunInput,
	declaredProvider: string | undefined,
): Promise<void> {
	await assertProviderQuotaOpen(input.repos, {
		credential: { provider: declaredProvider, env: input.serverEnv ?? process.env },
		now: input.now?.() ?? new Date(),
		...(input.force !== undefined ? { force: input.force } : {}),
	});
}

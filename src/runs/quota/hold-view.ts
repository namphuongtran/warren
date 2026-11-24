/**
 * The held-run view (namphuongtran/warren#30): which runs on a page are
 * waiting for a provider quota window, for the runs list.
 *
 * A run is held while it is `queued` with no workload and its newest hold
 * event is `dispatch.quota_held` (`./hold.ts`). Once the releaser writes its
 * `releasing` claim, or the run is cancelled, the run is no longer shown as
 * held. One batched query reads the hold events across the page, and a page
 * with no waiting runs makes no query.
 */

import {
	PROVIDER_QUOTA_EXHAUSTED,
	QUOTA_HOLD_EVENTS,
	type QuotaHoldView,
} from "../../core/wire.ts";
import type { Repos } from "../../db/repos/index.ts";
import type { RunRow } from "../../db/schema.ts";
import {
	isHeldRunPending,
	newestHoldEventByRun,
	QUOTA_HOLD_KINDS,
	readHeldDecision,
} from "./hold.ts";

/** The runs among `runs` that wait for a provider quota window now, keyed by run id. */
export async function currentQuotaHolds(
	repos: Pick<Repos, "events">,
	runs: readonly RunRow[],
): Promise<Map<string, QuotaHoldView>> {
	const holds = new Map<string, QuotaHoldView>();
	const waiting = runs.filter(isHeldRunPending);
	if (waiting.length === 0) return holds;
	const events = await repos.events.listEventsByKindsForRuns(
		waiting.map((run) => run.id),
		QUOTA_HOLD_KINDS,
	);
	for (const [runId, event] of newestHoldEventByRun(events)) {
		if (event.kind !== QUOTA_HOLD_EVENTS.held) continue;
		const decision = readHeldDecision(event.payloadJson);
		if (decision === null) continue;
		const { resetsAt, releaseAt } = decision;
		holds.set(runId, { reason: PROVIDER_QUOTA_EXHAUSTED, resetsAt, releaseAt });
	}
	return holds;
}

/**
 * PR check summary reader (namphuongtran/warren#41).
 *
 * The merge watcher calls this on each poll with the head commit the PR
 * read returned, and stores the result on the run.
 */

import { isFailedCheckRun } from "../ci-fixer/check-runs.ts";
import type { RunPrChecks } from "../core/wire.ts";
import type { Forge } from "../forge/contract.ts";
import { resolvePollTarget } from "./pr-merge.ts";

/** Read the PR head commit's checks; null when there is nothing to store. */
export type PrChecksReader = (prUrl: string, headCommit: string) => Promise<RunPrChecks | null>;

export interface CreatePrChecksReaderInput {
	/** Boot-resolved forge (ServerDeps.forge). */
	readonly forge: Forge;
	readonly now?: () => Date;
}

export function createPrChecksReader(input: CreatePrChecksReaderInput): PrChecksReader {
	const { forge } = input;
	const now = input.now ?? (() => new Date());
	return async (prUrl, headCommit) => {
		const none = (): RunPrChecks => ({
			state: "none",
			failing: [],
			commit: headCommit,
			checkedAt: now().toISOString(),
		});
		const target = resolvePollTarget(forge, prUrl);
		if (target.kind === "unparseable") return null;
		if (!forge.capabilities.checkRuns) return none();
		const listed = await forge.listChecks(target.ref, headCommit);
		if (!listed.ok) return listed.error.kind === "unsupported" ? none() : null;
		const { conclusion, runs } = listed.value;
		if (conclusion === "unknown") return none();
		return {
			state: conclusion,
			failing: runs.filter(isFailedCheckRun).map((run) => run.name),
			commit: headCommit,
			checkedAt: now().toISOString(),
		};
	};
}

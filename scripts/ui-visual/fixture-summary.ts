/**
 * Run detail Summary fixtures (namphuongtran/warren#38): the reap-written
 * facts the Summary tab reads, attached to three of the lifecycle-state runs
 * so each Summary shape renders against real rows.
 *
 * - `prOpen` is the full run: an approach note, a `done` handoff that left
 *   the plan with a reason, a passing gate, a transcript, and a judge verdict
 *   whose class points at event ranges inside that transcript.
 * - `failed` is the blocked run: an approach note, a `blocked` handoff with
 *   open questions, and a failing gate. The judge has not scored it.
 * - `succeeded` is the run with no extras: no approach note and no handoff.
 */

import type { RunHandoffRecord } from "../../src/core/wire.ts";
import type { Repos } from "../../src/db/repos/index.ts";

export interface SummaryRunIds {
	readonly prOpen: string;
	readonly failed: string;
	readonly succeeded: string;
}

/** A judge verdict pinned to one run, served after the history verdicts. */
export interface PinnedJudgeVerdict {
	readonly runId: string;
	readonly endedAt: string;
	readonly assignments: readonly {
		readonly class: string;
		readonly confidence: "low" | "medium" | "high";
		readonly evidence: readonly { readonly fromSeq: number; readonly toSeq: number }[];
		readonly note?: string;
	}[];
}

const FULL_APPROACH = `## Understanding
Telemetry deep links lose their query string below 640px, because the phone tab strip rebuilds the URL from the tab id alone.

## Options considered
1. Carry the search params through the tab strip. Small, but every tab must forward them.
2. Move the filters into route state. Cleaner, but it breaks bookmarked links.

## Chosen approach and why
Option 1: it keeps every existing link working.

## Risks / unknowns
The economics tab reads its own params; it may need the same fix.

## Verification plan
Add a phone-width spec that opens a deep link and asserts the filter survives.`;

const FULL_HANDOFF: RunHandoffRecord = {
	state: "recorded",
	handoff: {
		status: "done",
		summary:
			"The phone tab strip now forwards the current search params, so a telemetry deep link keeps its filters at every width.",
		verification: [
			{ command: "bun test src/ui/src/pages/telemetry", outcome: "48 pass, 0 fail" },
			{ command: "bun run check:all --bail", outcome: "12/12 gates passed" },
		],
		howToTry: [
			"Open Telemetry, Economics on a phone-width window.",
			"Pick a provider filter, copy the URL, and open it in a new tab.",
		],
		openQuestions: [],
		approach: {
			followed: false,
			deviation:
				"The economics tab needed the same forwarding, so the fix moved into the shared tab strip instead of each tab.",
		},
	},
};

const BLOCKED_APPROACH = `## Understanding
Move the plan-runs table onto the card primitive without changing its columns.

## Chosen approach and why
Swap the table rows for InventoryRowCard and keep the sort header.`;

const BLOCKED_HANDOFF: RunHandoffRecord = {
	state: "recorded",
	handoff: {
		status: "blocked",
		summary:
			"The card primitive has no slot for the child-progress bar, so the migration stopped before any table code changed.",
		verification: [{ command: "bun run typecheck", outcome: "passed before the stop" }],
		howToTry: [],
		openQuestions: [
			"Should the card primitive grow a progress slot, or should the progress bar move under the card?",
			"Can the sort header stay a table header above a card list?",
		],
	},
};

/** Attach the Summary facts to the three runs. */
export async function seedRunSummaries(repos: Repos, ids: SummaryRunIds): Promise<void> {
	await repos.runs.setApproach(ids.prOpen, {
		state: "recorded",
		markdown: FULL_APPROACH,
		truncated: false,
	});
	await repos.runs.setHandoff(ids.prOpen, FULL_HANDOFF);
	await repos.runs.setQualityGateOutcome(ids.prOpen, "passed");

	await repos.runs.setApproach(ids.failed, {
		state: "recorded",
		markdown: BLOCKED_APPROACH,
		truncated: false,
	});
	await repos.runs.setHandoff(ids.failed, BLOCKED_HANDOFF);
	await repos.runs.setQualityGateOutcome(ids.failed, "failed");

	await repos.runs.setApproach(ids.succeeded, {
		state: "missing",
		reason: "the run did not write .warren/approach.md",
	});
	await repos.runs.setHandoff(ids.succeeded, {
		state: "missing",
		reason: "the run did not write .warren/handoff.json",
	});
	await repos.runs.setQualityGateOutcome(ids.succeeded, "unconfigured");
}

/** The full run's judge verdict: one class, pointed at two event ranges. */
export function pinnedJudgeVerdicts(ids: SummaryRunIds, endedAt: string): PinnedJudgeVerdict[] {
	return [
		{
			runId: ids.prOpen,
			endedAt,
			assignments: [
				{
					class: "scope_creep",
					confidence: "medium",
					evidence: [
						{ fromSeq: 2, toSeq: 5 },
						{ fromSeq: 9, toSeq: 9 },
					],
					note: "Reworked the economics tab, which the task did not name.",
				},
			],
		},
	];
}

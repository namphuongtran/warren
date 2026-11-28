/**
 * Run detail Summary fixtures (namphuongtran/warren#38): the reap-written
 * facts the Summary tab reads, attached to three of the lifecycle-state runs
 * so each Summary shape renders against real rows.
 *
 * - `prOpen` is the full run: an approach note, a `done` handoff that left
 *   the plan with a reason, a passing gate, a transcript, and a judge verdict
 *   whose class points at event ranges inside that transcript. Its PR head
 *   has a failing check (namphuongtran/warren#41), and reap flagged three
 *   shortcuts in its diff (namphuongtran/warren#37).
 * - `failed` is the blocked run: an approach note, a `blocked` handoff with
 *   open questions, a failing gate, and a diff scanned clean. The judge has
 *   not scored it.
 * - `succeeded` is the run with no extras: no approach note, no handoff, and
 *   no shortcut scan.
 */

import type { RunHandoffRecord, RunPrChecks, RunQualityFlags } from "../../src/core/wire.ts";
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
			{
				question:
					"Should the card primitive grow a progress slot, or should the progress bar move under the card?",
				options: ["Grow a footer slot on the card", "Move the progress bar under the card"],
				recommendation:
					"Grow a footer slot. Other inventory lists need the same slot for their own progress.",
			},
			{
				question: "Can the sort header stay a table header above a card list?",
				options: [],
				recommendation: null,
			},
		],
	},
};

/** The full run's shortcut flags: a command flag, a whole-file flag, and a line flag. */
const FULL_FLAGS: RunQualityFlags = {
	flags: [
		{ kind: "hook_bypass", path: null, line: null, detail: "git commit --no-verify" },
		{
			kind: "protected_file",
			path: "scripts/bundle-size-budgets.json",
			line: null,
			detail: "**/*budget*.json",
		},
		{
			kind: "suppression",
			path: "src/ui/src/pages/telemetry/tab-strip.tsx",
			line: 42,
			detail: "biome-ignore",
		},
	],
	omitted: 0,
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
	await repos.runs.setQualityFlags(ids.prOpen, FULL_FLAGS);
	await repos.runs.setPrChecks(ids.prOpen, {
		...prChecks("failing", ["e2e (phone, dark theme)"]),
		// namphuongtran/warren#38: the controller's warren/review verdict on the same head.
		review: { state: "changes_requested", description: "Changes requested (fix round 1 of 2)" },
	});

	await repos.runs.setApproach(ids.failed, {
		state: "recorded",
		markdown: BLOCKED_APPROACH,
		truncated: false,
	});
	await repos.runs.setHandoff(ids.failed, BLOCKED_HANDOFF);
	await repos.runs.setQualityGateOutcome(ids.failed, "failed");
	await repos.runs.setQualityFlags(ids.failed, { flags: [], omitted: 0 });

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

/**
 * The other gate outcomes, on the first history runs, so the runs list renders
 * every gate word, including its longest ones (namphuongtran/warren#36).
 */
export async function seedListGateOutcomes(
	repos: Repos,
	historyRunIds: readonly string[],
): Promise<void> {
	const outcomes = ["not_run", "stale", "unknown"] as const;
	for (const [i, outcome] of outcomes.entries()) {
		const runId = historyRunIds[i];
		if (runId !== undefined) await repos.runs.setQualityGateOutcome(runId, outcome);
	}
}

const FIXTURE_HEAD = "4f1c2a9e8b7d6c5f4e3d2c1b0a9f8e7d6c5b4a39";

function prChecks(state: RunPrChecks["state"], failing: string[] = []): RunPrChecks {
	return { state, failing, commit: FIXTURE_HEAD, checkedAt: "2026-11-21T10:00:00.000Z" };
}

/**
 * The other check states, on the first history runs that opened a PR, so the
 * runs list renders every check word (namphuongtran/warren#41).
 */
export async function seedListPrChecks(
	repos: Repos,
	historyRunIds: readonly string[],
): Promise<void> {
	const states = [prChecks("passing"), prChecks("pending"), prChecks("none")];
	for (const runId of historyRunIds) {
		const next = states[0];
		if (next === undefined) return;
		if ((await repos.runs.get(runId))?.prUrl == null) continue;
		await repos.runs.setPrChecks(runId, next);
		states.shift();
	}
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

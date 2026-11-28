/**
 * Default renderer for the `handoff` PR-body fragment
 * (namphuongtran/warren#21): the agent's validated `.warren/handoff.json`, or
 * a one-line note saying why there is none.
 *
 * Every field is agent output. Prose that could open its own `#` heading or
 * echo a preview marker is fenced, and list items are flattened to one line,
 * so the report cannot break the PR body's section structure.
 */

import { fencedBlock, longestBacktickRun } from "../core/markdown-fence.ts";
import type {
	RunHandoff,
	RunHandoffApproach,
	RunHandoffQuestion,
	RunHandoffRecord,
} from "../core/wire.ts";
import { neutralizePreviewMarkers } from "./pr-agent-report.ts";

/** One line, safe as a markdown list item. */
function oneLine(text: string): string {
	return neutralizePreviewMarkers(text).replace(/\s+/g, " ").trim();
}

/** An inline code span that no backtick run inside `text` can close early. */
function codeSpan(text: string): string {
	const flat = oneLine(text);
	const ticks = "`".repeat(longestBacktickRun(flat) + 1);
	const pad = flat.startsWith("`") || flat.endsWith("`") ? " " : "";
	return `${ticks}${pad}${flat}${pad}${ticks}`;
}

/** The summary as markdown, fenced when it carries headings. */
function renderSummary(summary: string): string {
	const text = neutralizePreviewMarkers(summary.trim());
	if (!text.split("\n").some((line) => line.trimStart().startsWith("#"))) return text;
	return fencedBlock(text, "text");
}

function bulletSection(title: string, items: readonly string[]): string[] {
	if (items.length === 0) return [];
	return ["", `**${title}**`, "", ...items.map((item) => `- ${item}`)];
}

/** One line on whether the work followed the run's approach note (namphuongtran/warren#33). */
function approachLine(approach: RunHandoffApproach | undefined): string[] {
	if (approach === undefined) return [];
	const verdict = approach.followed
		? "followed the approach note"
		: "deviated from the approach note";
	const why = approach.deviation === null ? "" : `: ${oneLine(approach.deviation)}`;
	return ["", `**Approach:** ${verdict}${why}`];
}

/**
 * One open question (namphuongtran/warren#25): the question as the bullet,
 * then the options the agent weighed and its recommendation nested under it.
 */
function questionItem(question: RunHandoffQuestion): string {
	const details = [
		...question.options.map((option) => `Option: ${oneLine(option)}`),
		...(question.recommendation === null
			? []
			: [`Recommended: ${oneLine(question.recommendation)}`]),
	];
	return [oneLine(question.question), ...details.map((line) => `  - ${line}`)].join("\n");
}

function renderRecorded(handoff: RunHandoff): string {
	const verification = handoff.verification.map(
		(step) => `${codeSpan(step.command)}: ${oneLine(step.outcome)}`,
	);
	return [
		"## Handoff",
		"",
		`**Status:** ${handoff.status}`,
		"",
		renderSummary(handoff.summary),
		...approachLine(handoff.approach),
		...bulletSection("Verification", verification),
		...bulletSection("How to try", handoff.howToTry.map(oneLine)),
		...bulletSection("Open questions", handoff.openQuestions.map(questionItem)),
	].join("\n");
}

/** Render the `## Handoff` section for a recorded, missing, or invalid handoff. */
export function defaultHandoff(record: RunHandoffRecord): string {
	if (record.state === "recorded") return renderRecorded(record.handoff);
	const lead = record.state === "missing" ? "No handoff report" : "Invalid handoff report";
	return `## Handoff\n\n${lead}: ${oneLine(record.reason)}.`;
}

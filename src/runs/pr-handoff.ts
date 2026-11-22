/**
 * Default renderer for the `handoff` PR-body fragment
 * (namphuongtran/warren#21): the agent's validated `.warren/handoff.json`, or
 * a one-line note saying why there is none.
 *
 * Every field is agent output. Prose that could open its own `#` heading or
 * echo a preview marker is fenced, and list items are flattened to one line,
 * so the report cannot break the PR body's section structure.
 */

import type { RunHandoff, RunHandoffRecord } from "../core/wire.ts";
import { fenceFor, longestBacktickRun, neutralizePreviewMarkers } from "./pr-agent-report.ts";

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
	const fence = fenceFor(text);
	return `${fence}text\n${text}\n${fence}`;
}

function bulletSection(title: string, items: readonly string[]): string[] {
	if (items.length === 0) return [];
	return ["", `**${title}**`, "", ...items.map((item) => `- ${item}`)];
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
		...bulletSection("Verification", verification),
		...bulletSection("How to try", handoff.howToTry.map(oneLine)),
		...bulletSection("Open questions", handoff.openQuestions.map(oneLine)),
	].join("\n");
}

/** Render the `## Handoff` section for a recorded, missing, or invalid handoff. */
export function defaultHandoff(record: RunHandoffRecord): string {
	if (record.state === "recorded") return renderRecorded(record.handoff);
	const lead = record.state === "missing" ? "No handoff report" : "Invalid handoff report";
	return `## Handoff\n\n${lead}: ${oneLine(record.reason)}.`;
}

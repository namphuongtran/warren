/**
 * `warren attention` — the finished runs that wait on the operator
 * (namphuongtran/warren#26): blocked runs with open questions, failed runs
 * nothing retried, quality signals on undelivered work, and PRs whose review
 * asked for changes. A one-shot `GET /attention` through the SDK.
 *
 * Default output is one ndjson line per item, the `GET /attention` item
 * as-is, so an agent can read the questions. `--output pretty` renders a
 * table plus each blocked run's questions. Answering stays on the UI's
 * Needs attention page, which dispatches the continuation.
 */

import { InvalidArgumentError } from "commander";
import type { RunAttentionItem, RunAttentionResponse, WarrenClient } from "../../client/index.ts";
import { OPS_WINDOWS, type OpsWindow } from "../../core/wire.ts";
import type { CliContext, WriteSink } from "../output.ts";
import { commandFailure, outputMode, writeJsonLine } from "../output.ts";
import { renderTable } from "../table.ts";

export interface AttentionDeps {
	readonly client: WarrenClient;
}

export interface AttentionOptions {
	/** Trailing window of queued runs; the server defaults to 7d. */
	readonly window?: OpsWindow;
}

export interface AttentionResult {
	readonly exitCode: number;
	readonly count?: number;
}

/** Commander parser for `--window`: one of the `OPS_WINDOWS` tokens. */
export function parseAttentionWindow(value: string): OpsWindow {
	if (!(OPS_WINDOWS as readonly string[]).includes(value)) {
		throw new InvalidArgumentError(`expected one of ${OPS_WINDOWS.join(", ")}`);
	}
	return value as OpsWindow;
}

export async function runAttention(
	context: CliContext,
	deps: AttentionDeps,
	options: AttentionOptions,
): Promise<AttentionResult> {
	try {
		const body = await deps.client.listAttention(options.window);
		if (outputMode(context) === "pretty") {
			renderAttentionPretty(context.stdio.stdout, body);
		} else {
			for (const item of body.items) writeJsonLine(context.stdio.stdout, item);
		}
		return { exitCode: 0, count: body.items.length };
	} catch (err) {
		return commandFailure(context, err);
	}
}

const TASK_WIDTH = 60;

/** The task's first line, clipped for a table cell. */
function taskCell(prompt: string): string {
	const first = prompt.split("\n", 1)[0]?.trim() ?? "";
	return first.length > TASK_WIDTH ? `${first.slice(0, TASK_WIDTH - 1)}…` : first;
}

function renderQuestions(line: (text: string) => void, item: RunAttentionItem): void {
	const handoff = item.run.handoff;
	if (handoff?.state !== "recorded" || handoff.handoff.openQuestions.length === 0) return;
	line("");
	line(`${item.run.id} asks:`);
	for (const [i, q] of handoff.handoff.openQuestions.entries()) {
		line(`  ${i + 1}. ${q.question}`);
		for (const option of q.options) line(`     - ${option}`);
		if (q.recommendation !== null) line(`     Recommended: ${q.recommendation}`);
	}
}

function renderAttentionPretty(sink: WriteSink, body: RunAttentionResponse): void {
	const line = (text: string): void => sink.write(`${text}\n`);
	if (body.items.length === 0) {
		line(`(nothing needs attention in the last ${body.window})`);
		return;
	}
	const header = ["category", "run", "agent", "reasons", "task"];
	const rows = body.items.map((item) => [
		item.category,
		item.run.id,
		item.run.agentName,
		item.reasons.join(", "),
		taskCell(item.run.prompt),
	]);
	renderTable(sink, header, rows);
	const blocked = body.items.filter((item) => item.category === "blocked");
	for (const item of blocked) renderQuestions(line, item);
	if (blocked.length > 0) {
		line("");
		line("Answer from the Needs attention page in the UI; it dispatches the continuation.");
	}
}

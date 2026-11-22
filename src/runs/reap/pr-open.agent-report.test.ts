import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { parseJsonlClaude } from "../../runtime/adapters/parsers/jsonl-claude.ts";
import { reapRun } from "./index.ts";
import {
	type Ctx,
	fakeBurrowClient,
	fakeExec,
	fakeForge,
	fakeFs,
	makeBurrow,
	reapDeps,
	setup,
} from "./test-helpers.ts";

/**
 * namphuongtran/warren#42: the PR body carries the agent's final report, the
 * last assistant `text` event before the terminal `result`. The fixture is a
 * claude-code stream-json session modeled on run `run_bp7s34zhq5vb`: a
 * background task resumed the session, so `result.result` holds an earlier
 * turn's text while the last `text` event holds the real handoff.
 */

const FIXTURE = join(import.meta.dir, "__golden__", "claude-code-resumed-session.jsonl");
const LAST_TEXT = "Not verified: pinning `setup-uv` to 0.6.3 is untested in CI.";
const RESULT_TEXT = "The agent will notify me when it finishes";
const AUTO_OPEN = { enabled: true, token: "ghp_xyz", warrenBaseUrl: null } as const;

async function appendClaudeEvents(ctx: Ctx, lines: readonly string[]): Promise<void> {
	let seq = 0;
	for (const line of lines) {
		for (const ev of parseJsonlClaude(line)) {
			seq += 1;
			await ctx.repos.events.append({
				runId: ctx.runId,
				sandboxEventSeq: seq,
				ts: new Date(Date.UTC(2026, 10, 21, 0, 0, seq)).toISOString(),
				kind: ev.kind,
				stream: ev.stream,
				payload: ev.payload,
			});
		}
	}
}

async function reapAndReadBody(ctx: Ctx): Promise<string> {
	const e = fakeExec({ revListCount: "2" });
	const forge = fakeForge();
	await reapRun({
		runId: ctx.runId,
		outcome: "succeeded",
		repos: ctx.repos,
		...reapDeps(fakeBurrowClient(makeBurrow()), { fs: fakeFs().fs, exec: e.exec }),
		broker: ctx.broker,
		fs: fakeFs().fs,
		exec: e.exec,
		autoOpenPr: AUTO_OPEN,
		forge,
	});
	const record = forge.store.getPr("x/y", 1);
	if (record === undefined || record === null) throw new Error("reap opened no PR");
	return record.body;
}

describe("reapRun PR body agent report (namphuongtran/warren#42)", () => {
	let ctx: Ctx;

	beforeEach(async () => {
		ctx = await setup();
	});

	afterEach(async () => {
		await ctx.db.close();
	});

	test("carries the last assistant text, not the result payload's text", async () => {
		const lines = (await Bun.file(FIXTURE).text()).split("\n");
		await appendClaudeEvents(ctx, lines);
		const body = await reapAndReadBody(ctx);
		const section = body.slice(body.indexOf("## Agent report"));
		expect(body).toContain("## Agent report");
		expect(section).toContain(LAST_TEXT);
		expect(section.split("\n## ")[0]).not.toContain(RESULT_TEXT);
	});

	test("skips a raw unknown envelope that happens to carry a text field", async () => {
		const lines = (await Bun.file(FIXTURE).text()).split("\n").filter((line) => line !== "");
		const notice = JSON.stringify({ type: "stream_notice", text: "UNKNOWN-ENVELOPE" });
		lines.splice(lines.length - 1, 0, notice);
		await appendClaudeEvents(ctx, lines);
		const section = (await reapAndReadBody(ctx)).split("## Agent report")[1] ?? "";
		expect(section).toContain(LAST_TEXT);
		expect(section).not.toContain("UNKNOWN-ENVELOPE");
	});

	test("renders no section when the run produced no assistant text", async () => {
		const lines = (await Bun.file(FIXTURE).text())
			.split("\n")
			.filter((line) => !line.includes('"type":"text"'));
		await appendClaudeEvents(ctx, lines);
		const body = await reapAndReadBody(ctx);
		expect(body).not.toContain("## Agent report");
	});
});

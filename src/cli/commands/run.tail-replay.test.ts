/**
 * namphuongtran/warren#45: when the follow tail drops mid-run, `warren run`
 * polls to the terminal state, then replays the events it never printed
 * (the agent's final `result` among them) before the `run.terminal` line.
 *
 * The fake server sits behind a real `WarrenClient` (fetch stub), so the
 * replay's `?since=` cursor goes over the same wire path production uses.
 */
import { describe, expect, test } from "bun:test";
import { type RunEvent, WarrenClient } from "../../client/index.ts";
import type { CliContext, OutputMode } from "../output.ts";
import { runRun } from "./run.ts";

const RUN_ID = "run-1";
const KINDS = ["system", "assistant", "tool_use", "tool_result", "result"] as const;
const EVENTS: RunEvent[] = KINDS.map((kind, i) => ({
	id: 100 + i,
	runId: RUN_ID,
	seq: i + 1,
	ts: `2026-11-22T00:00:0${i}Z`,
	kind,
	stream: "stdout",
	payload: kind === "result" ? { result: "final report" } : { n: i + 1 },
}));

function ndjsonLines(events: readonly RunEvent[]): string[] {
	return events.map((e) => `${JSON.stringify(e)}\n`);
}

/** NDJSON body that delivers `lines`, then fails the read like an ECONNRESET. */
function resettingBody(lines: readonly string[]): ReadableStream<Uint8Array> {
	const enc = new TextEncoder();
	let i = 0;
	return new ReadableStream<Uint8Array>({
		pull(controller) {
			const line = lines[i++];
			if (line === undefined) {
				controller.error(new Error("ECONNRESET: socket hang up"));
				return;
			}
			controller.enqueue(enc.encode(line));
		},
	});
}

function json(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

const NDJSON_HEADERS = { "content-type": "application/x-ndjson" };

interface FakeServer {
	readonly client: WarrenClient;
	/** Query strings of every `GET /runs/:id/events` request, in order. */
	readonly eventRequests: string[];
}

interface FakeServerOptions {
	/** Events the follow tail delivers before the connection resets. */
	readonly resetAfter: number;
	/** Make the non-follow (replay) read fail with a 500. */
	readonly replayFails?: boolean;
	/** Rows per non-follow read, like the server's snapshot page bound. */
	readonly pageSize?: number;
}

/** `GET /runs/:id/events`: the follow tail resets; a plain read honours `?since=`. */
function eventsResponse(url: URL, opts: FakeServerOptions): Response {
	if (url.searchParams.get("follow") === "1") {
		const lines = ndjsonLines(EVENTS.slice(0, opts.resetAfter));
		return new Response(resettingBody(lines), { status: 200, headers: NDJSON_HEADERS });
	}
	if (opts.replayFails === true) {
		return json(500, { error: { code: "internal", message: "events read failed" } });
	}
	const since = Number(url.searchParams.get("since") ?? "0");
	const page = EVENTS.filter((e) => e.seq > since).slice(0, opts.pageSize ?? EVENTS.length);
	const body = ndjsonLines(page).join("");
	return new Response(body, { status: 200, headers: NDJSON_HEADERS });
}

/** Fake warren behind a real `WarrenClient`: dispatch, a resetting tail, a terminal row. */
function fakeServer(opts: FakeServerOptions): FakeServer {
	const eventRequests: string[] = [];
	const runRow = (state: string) => ({
		id: RUN_ID,
		agentName: "claude-code",
		projectId: "prj_1",
		state,
		failureReason: null,
		prUrl: null,
	});
	const fetchStub = async (input: URL | RequestInfo, init?: RequestInit): Promise<Response> => {
		const url = new URL(String(input));
		if (url.pathname === "/healthz") return json(200, { ok: true });
		if (init?.method === "POST" && url.pathname === "/runs") {
			return json(201, {
				run: runRow("running"),
				sandbox: { id: "bur-1", workspacePath: "/ws/run-1" },
			});
		}
		if (url.pathname === `/runs/${RUN_ID}/events`) {
			eventRequests.push(url.search);
			return eventsResponse(url, opts);
		}
		if (url.pathname === `/runs/${RUN_ID}`) return json(200, { run: runRow("succeeded") });
		return json(404, { error: { code: "not_found", message: url.pathname } });
	};
	const client = new WarrenClient({
		config: { baseUrl: "https://w.local" },
		fetch: fetchStub as unknown as typeof fetch,
	});
	return { client, eventRequests };
}

function captureContext(output?: OutputMode): {
	context: CliContext;
	out: string[];
	err: string[];
} {
	const out: string[] = [];
	const err: string[] = [];
	const context: CliContext = {
		env: {},
		stdio: {
			stdout: { write: (c) => out.push(c) },
			stderr: { write: (c) => err.push(c) },
		},
		spawn: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
		...(output !== undefined ? { output } : {}),
	};
	return { context, out, err };
}

function parseLines(chunks: readonly string[]): Array<Record<string, unknown>> {
	return chunks
		.join("")
		.trimEnd()
		.split("\n")
		.map((l) => JSON.parse(l) as Record<string, unknown>);
}

const ARGS = { agent: "claude-code", project: "prj_1", prompt: "review the database" };
const FAST_POLL = { waitForRunOptions: { intervalMs: 1, timeoutMs: 1_000 } };

describe("runRun replay after a tail failure (namphuongtran/warren#45)", () => {
	test("prints every event once, in order, then run.terminal", async () => {
		const server = fakeServer({ resetAfter: 2 });
		const { context, out } = captureContext();
		const result = await runRun(context, { client: server.client, ...FAST_POLL }, ARGS);

		expect(result.exitCode).toBe(0);
		const lines = parseLines(out);
		expect(lines.map((l) => l.event)).toEqual([
			"run.spawned",
			"run.event",
			"run.event",
			"run.event",
			"run.event",
			"run.event",
			"run.terminal",
		]);
		const events = lines.filter((l) => l.event === "run.event");
		expect(events.map((l) => l.seq)).toEqual([1, 2, 3, 4, 5]);
		expect(events.at(-1)).toMatchObject({ kind: "result", payload: { result: "final report" } });
		// The replay asks only for what the tail missed, does not follow, and
		// stops at the first read that brings nothing new.
		expect(server.eventRequests).toEqual(["?follow=1", "?since=2", "?since=5"]);
	});

	test("replays the whole log when the tail resets before the first event", async () => {
		const server = fakeServer({ resetAfter: 0 });
		const { context, out } = captureContext();
		await runRun(context, { client: server.client, ...FAST_POLL }, ARGS);

		const seqs = parseLines(out)
			.filter((l) => l.event === "run.event")
			.map((l) => l.seq);
		expect(seqs).toEqual([1, 2, 3, 4, 5]);
		expect(server.eventRequests).toEqual(["?follow=1", "", "?since=5"]);
	});

	test("renders the replayed events in pretty mode before the terminal line", async () => {
		const server = fakeServer({ resetAfter: 2 });
		const { context, out } = captureContext("pretty");
		await runRun(context, { client: server.client, ...FAST_POLL }, ARGS);

		const lines = out.join("").trimEnd().split("\n");
		expect(lines).toHaveLength(7); // spawned + 5 events + terminal
		expect(lines.at(-2)).toContain("result");
		expect(lines.at(-1)).toContain(`run ${RUN_ID} succeeded`);
	});

	test("reports a failed replay on stderr and keeps the run's exit code", async () => {
		const server = fakeServer({ resetAfter: 2, replayFails: true });
		const { context, out, err } = captureContext();
		const result = await runRun(context, { client: server.client, ...FAST_POLL }, ARGS);

		expect(result.exitCode).toBe(0);
		expect(err.join("")).toContain(`could not replay the missed events for run ${RUN_ID}`);
		expect(err.join("")).toContain(`GET /runs/${RUN_ID}/events`);
		expect(parseLines(out).at(-1)?.event).toBe("run.terminal");
	});

	test("pages through a backlog larger than one read", async () => {
		const server = fakeServer({ resetAfter: 1, pageSize: 2 });
		const { context, out } = captureContext();
		await runRun(context, { client: server.client, ...FAST_POLL }, ARGS);

		const events = parseLines(out).filter((l) => l.event === "run.event");
		expect(events.map((l) => l.seq)).toEqual([1, 2, 3, 4, 5]);
		expect(events.at(-1)?.kind).toBe("result");
		expect(server.eventRequests).toEqual(["?follow=1", "?since=1", "?since=3", "?since=5"]);
	});

	test("skips the replay read in json mode, which prints no events", async () => {
		const server = fakeServer({ resetAfter: 2 });
		const { context, err } = captureContext("json");
		const result = await runRun(context, { client: server.client, ...FAST_POLL }, ARGS);

		expect(result.exitCode).toBe(0);
		expect(server.eventRequests).toEqual(["?follow=1"]);
		expect(err.join("")).not.toContain("could not replay");
	});
});

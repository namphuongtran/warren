import { describe, expect, test } from "bun:test";
import type { RuntimeId } from "../../core/wire.ts";
import { claudeCodeAdapter } from "../adapters/claude-code.ts";
import type {
	AdapterRuntimeEvent,
	AgentRuntimeAdapter,
	SpawnCommand,
	SteeringMessage,
} from "../adapters/index.ts";
import { type AgentEnvSource, parseAgentEntrypointEnv, runAgent } from "./agent-entrypoint.ts";
import type { AgentInboxHttp, AgentProc, AgentSpawn } from "./agent-io.ts";
import { createStdinHoldController } from "./agent-stdin-hold.ts";

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

function streamOf(text: string): ReadableStream<Uint8Array> {
	return new ReadableStream({
		start(controller) {
			if (text.length > 0) controller.enqueue(new TextEncoder().encode(text));
			controller.close();
		},
	});
}

function baseEnv(overrides: Partial<Record<string, string>> = {}): AgentEnvSource {
	return {
		WARREN_RUN_ID: "run_01tdf3a0wg5e",
		WARREN_AGENT_RUNTIME: "pi-style",
		WARREN_PROMPT: "do the thing",
		WARREN_WORKSPACE_PATH: "/workspace",
		WARREN_API_URL: "http://warren.warren.svc.cluster.local:8080",
		WARREN_API_TOKEN: "tok",
		...overrides,
	};
}

function collector(): { out: (line: string) => void; lines: string[] } {
	const lines: string[] = [];
	return { out: (line) => lines.push(line), lines };
}

const silent = (): void => {};

const emptyInbox: AgentInboxHttp = { get: async () => ({ status: 200, body: { messages: [] } }) };

/**
 * A pi-style runtime: declares `shouldCloseStdinOnEvent` (so the entrypoint must
 * hold stdin open until `agent_end`) and `encodeSteeringMessage` (so mid-run
 * inbox messages get written to the live stdin). Each stdout line is a
 * `{ type }` envelope; `agent_end` maps to a `state_change`/`system` event the
 * close-trigger predicate matches.
 */
const piStyleRuntime: AgentRuntimeAdapter = {
	runtimeId: "pi-style" as RuntimeId,
	harnessStatePrefixes: [],
	terminalErrorEnvelopeTypes: [],
	buildSpawnCommand: (ctx): SpawnCommand => ({ argv: ["pi"], stdin: ctx.prompt }),
	parseEvents: (line): AdapterRuntimeEvent[] => {
		const type = (JSON.parse(line) as { type: string }).type;
		return type === "agent_end"
			? [{ kind: "state_change", stream: "system", payload: { type } }]
			: [{ kind: "text", stream: "stdout", payload: { type } }];
	},
	shouldCloseStdinOnEvent: (ev): boolean => {
		if (ev.kind !== "state_change") return false;
		const payload = ev.payload as { type?: unknown } | null | undefined;
		return !!payload && payload.type === "agent_end";
	},
	encodeSteeringMessage: (m: SteeringMessage): { stdin: string } => ({
		stdin: `/prompt ${m.body}\n`,
	}),
};

/** A batch adapter with no stdin-hold seam (claude-code shape). */
const batchRuntime: AgentRuntimeAdapter = {
	runtimeId: "batch" as RuntimeId,
	harnessStatePrefixes: [],
	terminalErrorEnvelopeTypes: [],
	buildSpawnCommand: (ctx): SpawnCommand => ({ argv: ["batch"], stdin: ctx.prompt }),
	parseEvents: (line): AdapterRuntimeEvent[] => [
		{ kind: "text", stream: "stdout", payload: { line } },
	],
};

function stubRegistry(rt: AgentRuntimeAdapter): {
	get(id: string): AgentRuntimeAdapter | undefined;
} {
	return { get: (id) => (id === rt.runtimeId ? rt : undefined) };
}

interface StdinHoldCapture {
	holdStdin?: boolean;
	closeStdinCalls: number;
	closeStdinBeforeExit: boolean;
	writes: string[];
	killed: boolean;
}

function newCapture(): StdinHoldCapture {
	return { closeStdinCalls: 0, closeStdinBeforeExit: false, writes: [], killed: false };
}

/**
 * Spawn fake that scripts all `stdoutLines` up front, then either (a) withholds
 * process exit until `closeStdin()` is invoked (`exitMode: "on-close"`, mirrors
 * pi's "stdin EOF → exit" contract) or (b) exits on its own once stdout drains
 * (`exitMode: "auto"`, a child that died without emitting its close trigger).
 */
function scriptedSpawn(
	stdoutLines: string[],
	capture: StdinHoldCapture,
	exitMode: "on-close" | "auto",
): AgentSpawn {
	return (command): AgentProc => {
		capture.holdStdin = command.holdStdin;
		const blob = stdoutLines.map((l) => `${l}\n`).join("");
		let exited_ = false;
		let resolveExit!: (n: number) => void;
		const exited = new Promise<number>((r) => {
			resolveExit = r;
		});
		if (exitMode === "auto") queueMicrotask(() => resolveExit(0));
		return {
			stdout: streamOf(blob),
			stderr: streamOf(""),
			exited,
			closeStdin: async (): Promise<void> => {
				capture.closeStdinCalls += 1;
				if (capture.closeStdinCalls === 1) capture.closeStdinBeforeExit = !exited_;
				exited_ = true;
				resolveExit(0);
			},
			writeStdin: async (chunk: string): Promise<void> => {
				capture.writes.push(chunk);
			},
			kill: (): void => {
				capture.killed = true;
				exited_ = true;
				resolveExit(137);
			},
		};
	};
}

/* -------------------------------------------------------------------------- */
/* stdin-hold seam (warren-7a43 / burrow-5db3)                                  */
/* -------------------------------------------------------------------------- */

describe("runAgent · stdin-hold seam", () => {
	const piTrace = [
		JSON.stringify({ type: "response" }),
		JSON.stringify({ type: "agent_start" }),
		JSON.stringify({ type: "turn_start" }),
		JSON.stringify({ type: "agent_end" }),
	];

	test("holds stdin open for a pi-style runtime and closes it on agent_end", async () => {
		const capture = newCapture();
		// exitMode "on-close": the fake resolves exit ONLY when closeStdin fires,
		// so if the entrypoint failed to hold + close on agent_end this would hang.
		const result = await runAgent(parseAgentEntrypointEnv(baseEnv()), {
			registry: stubRegistry(piStyleRuntime),
			spawn: scriptedSpawn(piTrace, capture, "on-close"),
			http: emptyInbox,
			out: silent,
			log: silent,
			skipFinalize: true,
		});
		expect(result).toEqual({ exitCode: 0, phase: "succeeded", cancelledViaSignal: false });
		expect(capture.holdStdin).toBe(true);
		expect(capture.closeStdinCalls).toBe(1);
		expect(capture.closeStdinBeforeExit).toBe(true);
	});

	test("does NOT hold stdin for a runtime without the seam (current behavior)", async () => {
		const capture = newCapture();
		const result = await runAgent(
			parseAgentEntrypointEnv(baseEnv({ WARREN_AGENT_RUNTIME: "batch" })),
			{
				registry: stubRegistry(batchRuntime),
				spawn: scriptedSpawn(["alpha", "beta"], capture, "auto"),
				http: emptyInbox,
				out: silent,
				log: silent,
				skipFinalize: true,
			},
		);
		expect(result).toEqual({ exitCode: 0, phase: "succeeded", cancelledViaSignal: false });
		expect(capture.holdStdin).toBeUndefined();
		expect(capture.closeStdinCalls).toBe(0);
	});

	test("closes stdin defensively when the child exits before its close trigger", async () => {
		const capture = newCapture();
		// pi-style (holds stdin) but the trace never reaches agent_end and the
		// child exits on its own — the finally block must still drop the FD.
		const result = await runAgent(parseAgentEntrypointEnv(baseEnv()), {
			registry: stubRegistry(piStyleRuntime),
			spawn: scriptedSpawn(
				[JSON.stringify({ type: "response" }), JSON.stringify({ type: "turn_start" })],
				capture,
				"auto",
			),
			http: emptyInbox,
			out: silent,
			log: silent,
			skipFinalize: true,
		});
		expect(result).toEqual({ exitCode: 0, phase: "succeeded", cancelledViaSignal: false });
		expect(capture.holdStdin).toBe(true);
		expect(capture.closeStdinCalls).toBe(1);
	});

	test("delivers a mid-run steering message to the held stdin", async () => {
		const capture = newCapture();
		// stdout stays open after turn_start; agent_end is emitted only once the
		// steering write lands, so the run's terminal path is driven by the poll.
		let controller!: ReadableStreamDefaultController<Uint8Array>;
		const enc = new TextEncoder();
		const spawn: AgentSpawn = (command): AgentProc => {
			capture.holdStdin = command.holdStdin;
			let resolveExit!: (n: number) => void;
			const exited = new Promise<number>((r) => {
				resolveExit = r;
			});
			const stdout = new ReadableStream<Uint8Array>({
				start(c) {
					controller = c;
					c.enqueue(enc.encode(`${JSON.stringify({ type: "turn_start" })}\n`));
				},
			});
			return {
				stdout,
				stderr: streamOf(""),
				exited,
				closeStdin: async (): Promise<void> => {
					capture.closeStdinCalls += 1;
					resolveExit(0);
				},
				writeStdin: async (chunk: string): Promise<void> => {
					capture.writes.push(chunk);
					// The steering write reached the child — now let it finish.
					controller.enqueue(enc.encode(`${JSON.stringify({ type: "agent_end" })}\n`));
					controller.close();
				},
			};
		};
		// Initial inbox drain is empty; the mid-run poll (call #2) yields the message.
		let calls = 0;
		const http: AgentInboxHttp = {
			get: async () => {
				calls += 1;
				if (calls === 2) {
					return {
						status: 200,
						body: {
							messages: [
								{
									id: "m1",
									runId: null,
									body: "PIVOT NOW",
									priority: "urgent",
									fromActor: "op",
									state: "delivered",
									createdAt: "t",
									deliveredAt: "t",
								},
							],
						},
					};
				}
				return { status: 200, body: { messages: [] } };
			},
		};
		const result = await runAgent(
			parseAgentEntrypointEnv(baseEnv({ WARREN_INBOX_POLL_INTERVAL_MS: "10" })),
			{
				registry: stubRegistry(piStyleRuntime),
				spawn,
				http,
				out: silent,
				log: silent,
				skipFinalize: true,
			},
		);
		expect(result).toEqual({ exitCode: 0, phase: "succeeded", cancelledViaSignal: false });
		expect(capture.holdStdin).toBe(true);
		expect(capture.writes).toEqual(["/prompt PIVOT NOW\n"]);
		expect(capture.closeStdinCalls).toBe(1);
	});

	test("watchdog closes stdin + kills a stdin-held run that goes silent", async () => {
		const { out, lines } = collector();
		const capture = newCapture();
		// stdout emits one line then stays open forever; the child never exits on
		// its own. Only the idle watchdog can end the run.
		let controller!: ReadableStreamDefaultController<Uint8Array>;
		const enc = new TextEncoder();
		const spawn: AgentSpawn = (command): AgentProc => {
			capture.holdStdin = command.holdStdin;
			let resolveExit!: (n: number) => void;
			const exited = new Promise<number>((r) => {
				resolveExit = r;
			});
			const finish = (code: number): void => {
				try {
					controller.close();
				} catch {
					/* already closed */
				}
				resolveExit(code);
			};
			const stdout = new ReadableStream<Uint8Array>({
				start(c) {
					controller = c;
					c.enqueue(enc.encode(`${JSON.stringify({ type: "turn_start" })}\n`));
				},
			});
			return {
				stdout,
				stderr: streamOf(""),
				exited,
				closeStdin: async (): Promise<void> => {
					capture.closeStdinCalls += 1;
					finish(0);
				},
				writeStdin: async (): Promise<void> => {},
				kill: (): void => {
					capture.killed = true;
					finish(137);
				},
			};
		};
		const result = await runAgent(
			parseAgentEntrypointEnv(baseEnv({ WARREN_AGENT_STDIN_HOLD_IDLE_MS: "25" })),
			{
				registry: stubRegistry(piStyleRuntime),
				spawn,
				http: emptyInbox,
				out,
				log: silent,
				skipFinalize: true,
			},
		);
		expect(result.exitCode).toBe(0);
		expect(capture.holdStdin).toBe(true);
		expect(capture.closeStdinCalls).toBe(1);
		expect(
			lines.some((l) => (JSON.parse(l) as { kind: string }).kind === "stdin_hold_timeout"),
		).toBe(true);
	});
});

describe("createStdinHoldController · steering gate (namphuongtran/warren#150)", () => {
	const claudeEvents = (line: Record<string, unknown>): AdapterRuntimeEvent[] =>
		claudeCodeAdapter.parseEvents?.(JSON.stringify(line)) ?? [];
	const toolUse = (id: string) =>
		claudeEvents({
			type: "assistant",
			message: { content: [{ type: "tool_use", id, name: "Bash", input: {} }] },
			parent_tool_use_id: null,
		});
	const toolResult = (id: string) =>
		claudeEvents({
			type: "user",
			message: { content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] },
			parent_tool_use_id: null,
		});
	const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 40));
	const steer = { id: "m1", runId: null, body: "wrap up", priority: "high", fromActor: "op" };

	/** A claude-code stdin hold whose inbox returns `steer` on the first claim. */
	function gatedHold(onClaim: () => Promise<void> = async () => {}) {
		// `claimsAtWrite[i]`: how many claims had happened when write i landed.
		const seen = { claims: 0, writes: [] as string[], claimsAtWrite: [] as number[] };
		const http: AgentInboxHttp = {
			get: async () => {
				seen.claims += 1;
				await onClaim();
				return { status: 200, body: { messages: seen.claims === 1 ? [steer] : [] } };
			},
		};
		const controller = createStdinHoldController({
			active: true,
			env: parseAgentEntrypointEnv(
				baseEnv({ WARREN_AGENT_RUNTIME: "claude-code", WARREN_INBOX_POLL_INTERVAL_MS: "5" }),
			),
			runtime: claudeCodeAdapter,
			proc: {
				stdout: streamOf(""),
				stderr: streamOf(""),
				exited: new Promise<number>(() => {}),
				closeStdin: async (): Promise<void> => {},
				writeStdin: async (chunk: string): Promise<void> => {
					seen.writes.push(chunk);
					seen.claimsAtWrite.push(seen.claims);
				},
			},
			http,
			out: silent,
			log: silent,
		});
		return { controller, seen };
	}

	test("leaves the inbox unclaimed until a tool call opens claude-code's gate", async () => {
		// The poll endpoint marks what it returns delivered, so a gate that held
		// a claimed message would lose it. The gate must hold the claim itself.
		const { controller, seen } = gatedHold();
		controller.start();
		await settle();
		expect(seen.claims).toBe(0);

		await controller.onEvents(toolUse("t1"));
		await settle();
		expect(seen.claims).toBeGreaterThan(0);
		expect(seen.writes).toHaveLength(1);
		expect(seen.writes[0]).toContain("[STEERING] (priority: high) wrap up");
		await controller.stop();
	});

	test("holds a claimed steer when the gate closes during the claim, until it opens again", async () => {
		let hold!: ReturnType<typeof gatedHold>;
		// The tool call finishes while the claim's HTTP round trip is in flight.
		hold = gatedHold(async () => {
			if (hold.seen.claims === 1) await hold.controller.onEvents(toolResult("t1"));
		});
		const { controller, seen } = hold;
		controller.start();
		await controller.onEvents(toolUse("t1"));
		await settle();
		expect(seen.claims).toBe(1);
		expect(seen.writes).toEqual([]);

		await controller.onEvents(toolUse("t2"));
		await settle();
		expect(seen.writes).toHaveLength(1);
		expect(seen.writes[0]).toContain("wrap up");
		// A held steer is written before anything new is claimed.
		expect(seen.claimsAtWrite).toEqual([1]);
		await controller.stop();
	});
});

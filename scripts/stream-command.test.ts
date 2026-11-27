import { describe, expect, test } from "bun:test";
import { newLineSplitter, type StreamSinks, streamCommand } from "./stream-command.ts";

function collectingSinks(): { sinks: StreamSinks; out: { stdout: string; stderr: string } } {
	const out = { stdout: "", stderr: "" };
	return {
		out,
		sinks: {
			stdout: async (chunk) => {
				out.stdout += chunk;
			},
			stderr: async (chunk) => {
				out.stderr += chunk;
			},
		},
	};
}

/** Run a bun one-liner as the child. */
function bunEval(script: string): string[] {
	return [process.execPath, "-e", script];
}

describe("newLineSplitter", () => {
	test("joins a line split across pushes and holds the unfinished one", () => {
		const lines: string[] = [];
		const splitter = newLineSplitter((line) => lines.push(line));
		splitter.push("All fi");
		splitter.push("les | 1.00 |\nnext");
		expect(lines).toEqual(["All files | 1.00 |"]);
		splitter.end();
		expect(lines).toEqual(["All files | 1.00 |", "next"]);
	});

	test("emits nothing at the end when the text closed on a newline", () => {
		const lines: string[] = [];
		const splitter = newLineSplitter((line) => lines.push(line));
		splitter.push("a\nb\n");
		splitter.end();
		expect(lines).toEqual(["a", "b"]);
	});
});

describe("streamCommand", () => {
	test("passes output far past spawnSync's 1 MiB default through whole (#151)", async () => {
		const { sinks, out } = collectingSinks();
		const lines: string[] = [];
		const result = await streamCommand(
			bunEval(
				'const row = "x".repeat(1023) + "\\n";' +
					"for (let i = 0; i < 3072; i++) process.stderr.write(row);" +
					'process.stderr.write("All files | 92.65 | 92.57 |\\n");' +
					'process.stdout.write("done");',
			),
			{ sinks, onLine: (line) => lines.push(line) },
		);
		expect(result).toEqual({ exitCode: 0, failure: null });
		expect(out.stderr.length).toBe(3072 * 1024 + "All files | 92.65 | 92.57 |\n".length);
		expect(out.stdout).toBe("done");
		expect(lines).toContain("All files | 92.65 | 92.57 |");
		expect(lines).toContain("done");
	});

	test("returns the child's own exit code", async () => {
		const { sinks } = collectingSinks();
		const result = await streamCommand(bunEval("process.exit(3)"), { sinks });
		expect(result).toEqual({ exitCode: 3, failure: null });
	});

	test("fails with the signal named when a signal ends the child", async () => {
		const { sinks } = collectingSinks();
		const result = await streamCommand(bunEval('process.kill(process.pid, "SIGKILL")'), {
			sinks,
		});
		expect(result.exitCode).toBe(1);
		expect(result.failure).toContain("SIGKILL");
	});

	test("fails with the cause when the command cannot start", async () => {
		const { sinks } = collectingSinks();
		const result = await streamCommand(["/nonexistent/warren-no-such-binary"], { sinks });
		expect(result.exitCode).toBe(1);
		expect(result.failure).toContain("could not start `/nonexistent/warren-no-such-binary`");
	});
});

/**
 * Run a child process and pass its output through as it arrives
 * (namphuongtran/warren#151).
 *
 * `spawnSync` holds a child's whole output in memory, up to `maxBuffer`
 * (1 MiB by default). Past that it kills the child. The coverage gate was
 * built on it, and once the suite's per-test lines on GitHub Actions grew
 * past 1 MiB the gate failed with a clipped log, no junit.xml, no lcov.info,
 * and no stated cause. Any fixed ceiling has the same failure, only later.
 *
 * This runner keeps no copy of the output. Each chunk goes to its sink as it
 * arrives, and the sink is awaited, so backpressure reaches the child and
 * nothing is left unflushed when the caller sets its exit code (warren-66a7).
 * The caller scans each complete line through `onLine`, so only the newest
 * unfinished line is ever held. A run that cannot start, or that a signal
 * ends, comes back as exit code 1 with a stated `failure`, never as a pass.
 */

/** Where each stream's chunks go, in arrival order. */
export interface StreamSinks {
	readonly stdout: (chunk: string) => Promise<void>;
	readonly stderr: (chunk: string) => Promise<void>;
}

export interface StreamCommandOptions {
	readonly cwd?: string;
	readonly sinks: StreamSinks;
	/** Called once per complete line of either stream, without its newline. */
	readonly onLine?: (line: string) => void;
}

export interface StreamCommandResult {
	/** The child's exit code, or 1 when it could not start or a signal ended it. */
	readonly exitCode: number;
	/** Why the run failed outside the child's own exit code, or null. */
	readonly failure: string | null;
}

/** A line splitter for streamed text that holds only the unfinished line. */
export interface LineSplitter {
	push(text: string): void;
	/** Emit the held line, if any. Call once after the last `push`. */
	end(): void;
}

export function newLineSplitter(onLine: (line: string) => void): LineSplitter {
	let partial = "";
	return {
		push(text) {
			const lines = (partial + text).split("\n");
			partial = lines.pop() ?? "";
			for (const line of lines) onLine(line);
		},
		end() {
			if (partial !== "") onLine(partial);
			partial = "";
		},
	};
}

function startPiped(argv: readonly string[], cwd: string | undefined) {
	return Bun.spawn([...argv], { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
}

/** Run `argv`, stream both outputs to `sinks`, and resolve once the child has exited. */
export async function streamCommand(
	argv: readonly string[],
	opts: StreamCommandOptions,
): Promise<StreamCommandResult> {
	const name = argv[0] ?? "<empty command>";
	let proc: ReturnType<typeof startPiped>;
	try {
		proc = startPiped(argv, opts.cwd);
	} catch (err) {
		return {
			exitCode: 1,
			failure: `could not start \`${name}\`: ${err instanceof Error ? err.message : String(err)}`,
		};
	}
	await Promise.all([
		pump(proc.stdout, opts.sinks.stdout, opts.onLine),
		pump(proc.stderr, opts.sinks.stderr, opts.onLine),
	]);
	const exitCode = await proc.exited;
	if (proc.signalCode !== null) {
		return { exitCode: 1, failure: `\`${name}\` was ended by ${proc.signalCode}` };
	}
	return { exitCode, failure: null };
}

async function pump(
	stream: ReadableStream<Uint8Array>,
	sink: (chunk: string) => Promise<void>,
	onLine: ((line: string) => void) | undefined,
): Promise<void> {
	const decoder = new TextDecoder();
	const lines = onLine === undefined ? null : newLineSplitter(onLine);
	const forward = async (text: string): Promise<void> => {
		if (text === "") return;
		await sink(text);
		lines?.push(text);
	};
	for await (const bytes of stream) await forward(decoder.decode(bytes, { stream: true }));
	await forward(decoder.decode());
	lines?.end();
}

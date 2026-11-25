/**
 * Shell-command reading for the quality-gate outcome (namphuongtran/warren#36).
 *
 * The harness-specific parse is already done by the time a command reaches
 * this module: the tool shape hands over the plain shell string a Bash-class
 * call ran. What is left is harness-neutral: does this command invoke the
 * configured gate, and does anything after the gate replace its exit status?
 *
 * Both questions are answered over simple-command segments, not raw text. A
 * small quote-aware tokenizer splits the command at `;`, `&&`, `||`, `|`, `&`,
 * and newlines, drops redirections, and strips quotes. The gate then matches
 * only as whole segments: a commit message or an `echo` that merely quotes the
 * gate is not a gate call, and a `;` inside quotes separates nothing. Heredocs,
 * command substitution, and subshell grouping are not modelled.
 */

/** The env var dispatch sets to the gate command (`src/runs/spawn/dispatch.ts`). */
export const QUALITY_GATE_ENV_VAR = "WARREN_QUALITY_GATE";

/** Operators that join simple commands. A newline reads as `;`. */
type Separator = ";" | "&&" | "||" | "|" | "&";

/** One simple command: its words (quotes stripped, redirections dropped) and what follows it. */
interface ShellSegment {
	readonly words: readonly string[];
	readonly next: Separator | null;
}

/** Where the gate's last invocation sits inside a command's segments. */
export interface GateInvocation {
	readonly segments: readonly ShellSegment[];
	/** Index of the gate's first segment. */
	readonly start: number;
	/** Index of the gate's last segment. */
	readonly end: number;
}

/** Operator spellings, longest first, and the separator each one reads as. */
const SEPARATOR_TOKENS: readonly (readonly [string, Separator])[] = [
	["&&", "&&"],
	["||", "||"],
	["|&", "|"],
	["|", "|"],
	["&", "&"],
	[";", ";"],
	["\n", ";"],
];

/** Character-level state for {@link splitShellCommand}. */
class ShellTokenizer {
	readonly segments: ShellSegment[] = [];
	private words: string[] = [];
	private word = "";
	private hasWord = false;
	/** The next completed word is a redirection target, so it is dropped. */
	private dropNextWord = false;

	constructor(private readonly text: string) {}

	run(): ShellSegment[] {
		let i = 0;
		while (i < this.text.length) i = this.step(i);
		this.endSegment(null);
		return this.segments;
	}

	private step(i: number): number {
		const c = this.text[i] ?? "";
		const next = this.text[i + 1] ?? "";
		if (c === "'" || c === '"') return this.quoted(i, c);
		if (c === "\\") {
			if (next !== "\n") this.append(next);
			return i + 2;
		}
		if (c === ">" || c === "<" || (c === "&" && next === ">")) return this.redirect(i);
		const separator = SEPARATOR_TOKENS.find(([token]) => this.text.startsWith(token, i));
		if (separator !== undefined) {
			this.endSegment(separator[1]);
			return i + separator[0].length;
		}
		if (/\s|[()]/.test(c)) this.endWord();
		else this.append(c);
		return i + 1;
	}

	private append(text: string): void {
		this.word += text;
		this.hasWord = true;
	}

	/** Read a quoted span; double quotes honour the backslash escapes the shell does. */
	private quoted(i: number, quote: string): number {
		this.hasWord = true;
		let j = i + 1;
		while (j < this.text.length && this.text[j] !== quote) {
			const ch = this.text[j] ?? "";
			const escaped = this.text[j + 1] ?? "";
			if (quote === '"' && ch === "\\" && /["\\$`]/.test(escaped)) {
				this.word += escaped;
				j += 2;
				continue;
			}
			this.word += ch;
			j++;
		}
		return j + 1;
	}

	/** `>`, `>>`, `<`, `&>`, `2>&1`: drop the fd number, the operator, and the target. */
	private redirect(i: number): number {
		if (/^\d+$/.test(this.word)) {
			this.word = "";
			this.hasWord = false;
		} else {
			this.endWord();
		}
		const op = /^(&>>?|>>?|<)(&(\d+|-))?/.exec(this.text.slice(i));
		const length = op?.[0].length ?? 1;
		// A duplicated fd (`>&1`) carries its own target; anything else names one next.
		this.dropNextWord = op?.[2] === undefined;
		return i + length;
	}

	private endWord(): void {
		if (!this.hasWord) return;
		if (this.dropNextWord) this.dropNextWord = false;
		else this.words.push(this.word);
		this.word = "";
		this.hasWord = false;
	}

	private endSegment(separator: Separator | null): void {
		this.endWord();
		if (this.words.length > 0) {
			this.segments.push({ words: this.words, next: separator });
		} else if (separator === null) {
			// A trailing `;` or `&&` joins nothing: the last command ends the line.
			const last = this.segments.pop();
			if (last !== undefined) this.segments.push({ ...last, next: null });
		}
		this.words = [];
	}
}

/** Split a shell command into simple-command segments. */
function splitShellCommand(command: string): ShellSegment[] {
	return new ShellTokenizer(command).run();
}

const ENV_ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;
const SHELLS = new Set(["bash", "sh", "zsh"]);
const ENV_REFERENCES = new Set([`$${QUALITY_GATE_ENV_VAR}`, `\${${QUALITY_GATE_ENV_VAR}}`]);

/**
 * Expand the indirections an agent wraps a gate in, so the gate's own segments
 * become visible: leading `VAR=value` assignments, `eval …`, `bash -c '…'`, and
 * a bare `$WARREN_QUALITY_GATE` reference (replaced by the gate's segments).
 */
function expandSegments(
	segments: readonly ShellSegment[],
	gateSegments: readonly ShellSegment[],
	depth = 0,
): ShellSegment[] {
	return segments.flatMap((segment) => {
		const words = segment.words.slice(segment.words.findIndex((w) => !ENV_ASSIGNMENT_RE.test(w)));
		const [head, flag] = words;
		let inner: ShellSegment[] | null = null;
		if (words.length === 1 && head !== undefined && ENV_REFERENCES.has(head)) {
			inner = [...gateSegments];
		} else if (head === "eval" && words.length > 1) {
			inner = splitShellCommand(words.slice(1).join(" "));
		} else if (
			head !== undefined &&
			SHELLS.has(head) &&
			flag !== undefined &&
			/^-[a-z]*c[a-z]*$/.test(flag) &&
			words[2] !== undefined
		) {
			inner = splitShellCommand(words[2]);
		}
		if (inner === null || inner.length === 0 || depth > 3) return [{ ...segment, words }];
		const expanded = expandSegments(inner, gateSegments, depth + 1);
		const last = expanded.pop();
		return last === undefined ? expanded : [...expanded, { ...last, next: segment.next }];
	});
}

/**
 * The words of each simple command inside `command`, with `VAR=value`
 * prefixes, `eval`, and `bash -c '…'` unwrapped. The shortcut scan
 * (namphuongtran/warren#37) reads git invocations through this.
 */
export function simpleCommandWords(command: string): string[][] {
	return expandSegments(splitShellCommand(command), []).map((segment) => [...segment.words]);
}

function sameWords(a: readonly string[], b: readonly string[]): boolean {
	return a.length === b.length && a.every((word, i) => word === b[i]);
}

/**
 * The gate's last invocation inside `command`, or `null` when the command does
 * not invoke it. The gate matches as a whole run of segments with the same
 * words and the same joining operators: `bun run check:all-fast` or
 * `pytest tests/one.py` is not the gate `bun run check:all` or `pytest`.
 */
export function findGateInvocation(command: string, gate: string): GateInvocation | null {
	const gateSegments = expandSegments(splitShellCommand(gate), []);
	if (gateSegments.length === 0) return null;
	const segments = expandSegments(splitShellCommand(command), gateSegments);
	for (let start = segments.length - gateSegments.length; start >= 0; start--) {
		const matches = gateSegments.every((g, j) => {
			const s = segments[start + j];
			const joinMatches = j === gateSegments.length - 1 || s?.next === g.next;
			return s !== undefined && joinMatches && sameWords(s.words, g.words);
		});
		if (matches) return { segments, start, end: start + gateSegments.length - 1 };
	}
	return null;
}

/**
 * Does the shell text after the gate's invocation replace the gate's exit
 * status with another command's? A pipe does (unless `pipefail` was set
 * before the gate), and so do `;`, `||`, and a backgrounding `&`. `&&` does
 * not: a failing gate still fails the whole command.
 */
export function masksExitStatus(invocation: GateInvocation): boolean {
	const { segments, start, end } = invocation;
	const pipefail = segments.slice(0, start).some((s) => s.words.includes("pipefail"));
	return segments.slice(end).some((segment) => {
		if (segment.next === null || segment.next === "&&") return false;
		return segment.next !== "|" || !pipefail;
	});
}

/** `exit=1`, `exit code: 2`, `EXIT_STATUS=0`: what an agent prints to keep a masked status. */
const EXIT_MARKER_RE = /\bexit(?:[ _-]?(?:code|status))?\s*[=:]?\s*(\d+)\b/gi;

/**
 * The exit status a command printed for itself, read from the last exit
 * marker in its output, or `null` when the output carries none. Agents print
 * one when they keep the gate's output out of the transcript:
 * `gate > /tmp/gate.log 2>&1; echo "exit=$?"`.
 */
export function readExitMarker(text: string): number | null {
	let status: number | null = null;
	for (const match of text.matchAll(EXIT_MARKER_RE)) {
		if (match[1] !== undefined) status = Number(match[1]);
	}
	return status;
}

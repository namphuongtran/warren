/**
 * A small reader for `git diff --unified=0` output (namphuongtran/warren#37).
 *
 * The shortcut scan only needs, per file: its paths, whether the diff
 * created or deleted it, the added lines with their head line numbers, and
 * the removed lines. Context lines never appear at `-U0`, so a hunk header's
 * `+start` is the head line of its first added line.
 */

export interface DiffLine {
	/** 1-based line in the head version of the file. */
	readonly line: number;
	readonly text: string;
}

export interface DiffFile {
	/** Head path; the old path when the file was deleted. */
	readonly path: string;
	readonly deleted: boolean;
	readonly added: readonly DiffLine[];
	/** Removed line texts, in diff order. */
	readonly removed: readonly string[];
}

interface MutableFile {
	oldPath: string | null;
	newPath: string | null;
	gitPath: string;
	deleted: boolean;
	added: DiffLine[];
	removed: string[];
}

const DIFF_HEADER = /^diff --git (?:a\/(.*) b\/(.*)|"(.*)" "(.*)")$/;
const C_ESCAPES: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13 };

/**
 * Undo git's C-style path quoting (`"caf\303\251.ts"`), used for non-ASCII
 * bytes, `"`, `\`, and control characters. An unquoted path passes through.
 */
export function unquoteGitPath(raw: string): string {
	if (!(raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2)) return raw;
	const bytes: number[] = [];
	const body = raw.slice(1, -1);
	for (let i = 0; i < body.length; i++) {
		const c = body[i] ?? "";
		if (c !== "\\") {
			bytes.push(...new TextEncoder().encode(c));
			continue;
		}
		const next = body[i + 1] ?? "";
		const octal = /^[0-7]{3}/.exec(body.slice(i + 1));
		if (octal !== null) {
			bytes.push(Number.parseInt(octal[0], 8));
			i += 3;
		} else {
			bytes.push(C_ESCAPES[next] ?? next.charCodeAt(0));
			i += 1;
		}
	}
	return new TextDecoder().decode(new Uint8Array(bytes));
}
const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/** Strip the `a/` / `b/` prefix from a `---` / `+++` path; `/dev/null` reads as absent. */
function headerPath(raw: string, prefix: "a/" | "b/"): string | null {
	const path = unquoteGitPath(raw.startsWith('"') ? raw : raw.replace(/\t.*$/, ""));
	if (path === "/dev/null") return null;
	return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

function finish(file: MutableFile): DiffFile {
	const path = (file.deleted ? file.oldPath : file.newPath) ?? file.gitPath;
	return { path, deleted: file.deleted, added: file.added, removed: file.removed };
}

/** Line-at-a-time state for {@link parseUnifiedDiff}. */
class DiffReader {
	readonly files: DiffFile[] = [];
	private file: MutableFile | null = null;
	private inHunk = false;
	private nextLine = 0;

	read(raw: string): void {
		// Any `diff --git` line opens a file, so an unparsed header never leaks
		// its lines into the previous one; `---` / `+++` then name the paths.
		const header = raw.startsWith("diff --git ") ? (DIFF_HEADER.exec(raw) ?? []) : null;
		if (header !== null) {
			const quoted = (p: string | undefined) =>
				p === undefined ? null : unquoteGitPath(`"${p}"`).replace(/^[ab]\//, "");
			this.startFile(header[1] ?? quoted(header[3]), header[2] ?? quoted(header[4]));
			return;
		}
		if (this.file === null) return;
		const hunk = HUNK_HEADER.exec(raw);
		if (hunk !== null) {
			this.nextLine = Number(hunk[1]);
			this.inHunk = true;
		} else if (this.inHunk) {
			this.hunkLine(this.file, raw);
		} else {
			this.fileHeaderLine(this.file, raw);
		}
	}

	end(): DiffFile[] {
		if (this.file !== null) this.files.push(finish(this.file));
		this.file = null;
		return this.files;
	}

	private startFile(oldPath: string | null, newPath: string | null): void {
		this.end();
		this.file = {
			oldPath,
			newPath,
			gitPath: newPath ?? oldPath ?? "",
			deleted: false,
			added: [],
			removed: [],
		};
		this.inHunk = false;
	}

	private fileHeaderLine(file: MutableFile, raw: string): void {
		if (raw.startsWith("deleted file mode")) file.deleted = true;
		else if (raw.startsWith("--- ")) file.oldPath = headerPath(raw.slice(4), "a/");
		else if (raw.startsWith("+++ ")) file.newPath = headerPath(raw.slice(4), "b/");
	}

	private hunkLine(file: MutableFile, raw: string): void {
		if (raw.startsWith("+")) {
			file.added.push({ line: this.nextLine, text: raw.slice(1) });
			this.nextLine++;
		} else if (raw.startsWith("-")) {
			file.removed.push(raw.slice(1));
		}
	}
}

/** Parse `git diff -U0` text into per-file changes. Unknown lines are skipped; never throws. */
export function parseUnifiedDiff(text: string): DiffFile[] {
	const reader = new DiffReader();
	for (const raw of text.split("\n")) reader.read(raw);
	return reader.end();
}

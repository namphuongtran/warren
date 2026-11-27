/**
 * Backtick fences for quoting agent output inside Markdown: a PR body or
 * another run's prompt. It lives in the kernel so the browser bundle and the
 * server read one definition.
 */

/** Length of the longest run of backticks in `text` (0 when there is none). */
export function longestBacktickRun(text: string): number {
	let longest = 0;
	for (const run of text.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
	return longest;
}

/**
 * `text` inside a backtick fence longer than any backtick run in it, opened
 * with the `info` string (`text`, `json`). CommonMark closes a fence only on
 * a run at least as long as the opener, so no fence inside the text can end
 * the quote early.
 */
export function fencedBlock(text: string, info: string): string {
	const fence = "`".repeat(Math.max(3, longestBacktickRun(text) + 1));
	return `${fence}${info}\n${text}\n${fence}`;
}

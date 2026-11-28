import { describe, expect, test } from "bun:test";
import { fencedBlock, longestBacktickRun } from "./markdown-fence.ts";

describe("fencedBlock", () => {
	test("wraps text in a three-backtick fence with its info string", () => {
		expect(fencedBlock("## Not a heading", "text")).toBe("```text\n## Not a heading\n```");
	});

	test("opens a fence longer than any backtick run inside the text", () => {
		expect(fencedBlock("before\n```\n## Escape\n```\nafter", "text")).toBe(
			"````text\nbefore\n```\n## Escape\n```\nafter\n````",
		);
	});
});

describe("longestBacktickRun", () => {
	test("measures the longest run of backticks", () => {
		expect(longestBacktickRun("a `b` ``c`` d")).toBe(2);
	});

	test("reads zero when the text has no backtick", () => {
		expect(longestBacktickRun("plain")).toBe(0);
	});
});

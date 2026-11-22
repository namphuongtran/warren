import { describe, expect, test } from "bun:test";
import { parseRunHandoff, RUN_HANDOFF_MAX_BYTES } from "./wire-handoff.ts";

describe("parseRunHandoff", () => {
	test("records a complete handoff", () => {
		const body = JSON.stringify({
			status: "done",
			summary: "Added the retry loop because the API flakes.",
			verification: [{ command: "bun test src/x.test.ts", outcome: "12 pass" }],
			howToTry: ["warren run --prompt hi", "open the PR"],
			openQuestions: ["Should the retry cap be configurable?"],
		});
		expect(parseRunHandoff(body)).toEqual({
			state: "recorded",
			handoff: {
				status: "done",
				summary: "Added the retry loop because the API flakes.",
				verification: [{ command: "bun test src/x.test.ts", outcome: "12 pass" }],
				howToTry: ["warren run --prompt hi", "open the PR"],
				openQuestions: ["Should the retry cap be configurable?"],
			},
		});
	});

	test("defaults the optional lists to empty and drops unknown keys", () => {
		const body = JSON.stringify({ status: "blocked", summary: "Needs a token.", extra: 1 });
		expect(parseRunHandoff(body)).toEqual({
			state: "recorded",
			handoff: {
				status: "blocked",
				summary: "Needs a token.",
				verification: [],
				howToTry: [],
				openQuestions: [],
			},
		});
	});

	test("flags a missing file", () => {
		expect(parseRunHandoff(null)).toEqual({
			state: "missing",
			reason: "the run did not write .warren/handoff.json",
		});
	});

	test("flags a body that is not JSON", () => {
		expect(parseRunHandoff("{status: done")).toEqual({
			state: "invalid",
			reason: ".warren/handoff.json is not valid JSON",
		});
	});

	test("flags an unknown status", () => {
		const body = JSON.stringify({ status: "finished", summary: "x" });
		expect(parseRunHandoff(body)).toEqual({
			state: "invalid",
			reason: "status must be one of done, partial, blocked",
		});
	});

	test("flags an empty summary", () => {
		const body = JSON.stringify({ status: "done", summary: "  " });
		expect(parseRunHandoff(body)).toEqual({
			state: "invalid",
			reason: "summary must be a non-empty string",
		});
	});

	test("flags a malformed verification entry", () => {
		const body = JSON.stringify({ status: "done", summary: "x", verification: ["bun test"] });
		expect(parseRunHandoff(body)).toEqual({
			state: "invalid",
			reason: "verification[0] must be an object with string command and outcome",
		});
	});

	test("flags a non-string list item", () => {
		const body = JSON.stringify({ status: "done", summary: "x", openQuestions: [42] });
		expect(parseRunHandoff(body)).toEqual({
			state: "invalid",
			reason: "openQuestions must be an array of strings",
		});
	});

	test("flags a top-level array", () => {
		expect(parseRunHandoff("[]")).toEqual({
			state: "invalid",
			reason: ".warren/handoff.json must hold a JSON object",
		});
	});

	test("flags a body over the size cap without parsing it", () => {
		const body = JSON.stringify({ status: "done", summary: "é".repeat(RUN_HANDOFF_MAX_BYTES) });
		expect(parseRunHandoff(body)).toEqual({
			state: "invalid",
			reason: ".warren/handoff.json is over the 16 KiB limit",
		});
	});
});

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

	// namphuongtran/warren#18: the reviewer's verdict rides the handoff.
	test("records a reviewer verdict with its findings", () => {
		const body = JSON.stringify({
			status: "done",
			summary: "Reviewed the retry loop.",
			review: {
				verdict: "request_changes",
				summary: "The retry loop never backs off.",
				findings: [
					{ title: "No backoff", body: "Sleep between tries.", path: "src/x.ts", line: 12 },
					{ title: "No test", body: "Cover the cap." },
				],
			},
		});
		expect(parseRunHandoff(body)).toEqual({
			state: "recorded",
			handoff: {
				status: "done",
				summary: "Reviewed the retry loop.",
				verification: [],
				howToTry: [],
				openQuestions: [],
				review: {
					verdict: "request_changes",
					summary: "The retry loop never backs off.",
					findings: [
						{ title: "No backoff", body: "Sleep between tries.", path: "src/x.ts", line: 12 },
						{ title: "No test", body: "Cover the cap.", path: null, line: null },
					],
				},
			},
		});
	});

	test("records an approval with no findings", () => {
		const body = JSON.stringify({
			status: "done",
			summary: "Reviewed.",
			review: { verdict: "approve", summary: "Safe to merge.", findings: [] },
		});
		const record = parseRunHandoff(body);
		expect(record.state === "recorded" ? record.handoff.review : null).toEqual({
			verdict: "approve",
			summary: "Safe to merge.",
			findings: [],
		});
	});

	test("flags an unknown review verdict", () => {
		const body = JSON.stringify({
			status: "done",
			summary: "x",
			review: { verdict: "lgtm", summary: "ok", findings: [] },
		});
		expect(parseRunHandoff(body)).toEqual({
			state: "invalid",
			reason: "review.verdict must be one of approve, request_changes",
		});
	});

	test("flags a change request with no findings", () => {
		const body = JSON.stringify({
			status: "done",
			summary: "x",
			review: { verdict: "request_changes", summary: "bad", findings: [] },
		});
		expect(parseRunHandoff(body)).toEqual({
			state: "invalid",
			reason: "review.findings must name at least one finding for request_changes",
		});
	});

	test("flags a malformed review finding", () => {
		const body = JSON.stringify({
			status: "done",
			summary: "x",
			review: { verdict: "request_changes", summary: "bad", findings: [{ title: "t" }] },
		});
		expect(parseRunHandoff(body)).toEqual({
			state: "invalid",
			reason: "review.findings[0] must be an object with non-empty string title and body",
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

describe("parseRunHandoff approach adherence (namphuongtran/warren#33)", () => {
	function withApproach(approach: unknown) {
		return parseRunHandoff(JSON.stringify({ status: "done", summary: "Done.", approach }));
	}

	test("records a followed approach with no deviation", () => {
		expect(withApproach({ followed: true })).toMatchObject({
			state: "recorded",
			handoff: { approach: { followed: true, deviation: null } },
		});
	});

	test("records a deviation and its reason", () => {
		expect(
			withApproach({ followed: false, deviation: "Queued the call; the retry loop raced." }),
		).toMatchObject({
			state: "recorded",
			handoff: {
				approach: { followed: false, deviation: "Queued the call; the retry loop raced." },
			},
		});
	});

	test("omits the block when the agent wrote none", () => {
		const record = parseRunHandoff('{"status":"done","summary":"Done."}');
		expect(record.state === "recorded" && "approach" in record.handoff).toBe(false);
	});

	test("flags a deviation without a reason", () => {
		expect(withApproach({ followed: false })).toEqual({
			state: "invalid",
			reason: "approach.deviation must say why the work left the approach note",
		});
	});

	test("flags a non-boolean followed", () => {
		expect(withApproach({ followed: "yes" })).toEqual({
			state: "invalid",
			reason: "approach.followed must be a boolean",
		});
	});
});

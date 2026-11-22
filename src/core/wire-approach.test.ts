import { describe, expect, test } from "bun:test";
import { clipRunApproachBody, parseRunApproach, RUN_APPROACH_MAX_BYTES } from "./wire-approach.ts";

const NOTE = `## Understanding
Retry the flaky API call. Out of scope: the backoff cap.

## Options considered
1. Retry loop in the client: small, local.
2. Queue the call: durable, but a new dependency.

## Chosen approach and why
Option 1, because the failure is transient.

## Risks / unknowns
The API may rate-limit retries.

## Verification plan
bun test src/retry.test.ts`;

describe("parseRunApproach", () => {
	test("records the note verbatim", () => {
		expect(parseRunApproach(NOTE)).toEqual({ state: "recorded", markdown: NOTE, truncated: false });
	});

	test("records a one-line approach for a trivial task", () => {
		expect(parseRunApproach("Fix the typo in README.\n")).toEqual({
			state: "recorded",
			markdown: "Fix the typo in README.\n",
			truncated: false,
		});
	});

	test("flags a missing file", () => {
		expect(parseRunApproach(null)).toEqual({
			state: "missing",
			reason: "the run did not write .warren/approach.md",
		});
	});

	test("flags a blank file as missing", () => {
		expect(parseRunApproach(" \n\t\n")).toEqual({
			state: "missing",
			reason: ".warren/approach.md is empty",
		});
	});

	test("truncates a note over the byte cap at a character boundary", () => {
		// Three-byte characters, so the byte cap lands mid-character.
		const body = "€".repeat(RUN_APPROACH_MAX_BYTES);
		const record = parseRunApproach(body);
		expect(record.state).toBe("recorded");
		if (record.state !== "recorded") return;
		expect(record.truncated).toBe(true);
		expect(record.markdown).toBe("€".repeat(Math.floor(RUN_APPROACH_MAX_BYTES / 3)));
	});
});

describe("clipRunApproachBody", () => {
	test("keeps a body within the cap and bounds a runaway one past it", () => {
		expect(clipRunApproachBody(NOTE)).toBe(NOTE);
		const clipped = clipRunApproachBody("x".repeat(RUN_APPROACH_MAX_BYTES * 4));
		expect(clipped.length).toBe(RUN_APPROACH_MAX_BYTES + 1);
		expect(parseRunApproach(clipped)).toMatchObject({ state: "recorded", truncated: true });
	});
});

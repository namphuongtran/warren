import { describe, expect, test } from "bun:test";
import {
	extractReviewVerdict,
	MAX_FINDING_BODY_CHARS,
	MAX_FINDINGS,
	parseReviewVerdict,
	REVIEW_VERDICT_CLOSE,
	REVIEW_VERDICT_OPEN,
} from "./verdict.ts";

function block(payload: unknown): string {
	return `${REVIEW_VERDICT_OPEN}\n${JSON.stringify(payload)}\n${REVIEW_VERDICT_CLOSE}`;
}

function textEvent(seq: number, text: string): Record<string, unknown> {
	return { seq, kind: "text", stream: "stdout", payload: { text } };
}

describe("parseReviewVerdict", () => {
	test("reads an approve verdict with no findings", () => {
		const result = parseReviewVerdict(
			`Looks good.\n${block({ verdict: "approve", summary: "Clean change.", findings: [] })}`,
		);
		expect(result).toEqual({
			ok: true,
			verdict: { verdict: "approve", summary: "Clean change.", findings: [] },
		});
	});

	test("reads request_changes findings with optional path and line", () => {
		const result = parseReviewVerdict(
			block({
				verdict: "request_changes",
				summary: "One bug.",
				findings: [
					{ title: "Off by one", body: "Loop skips the last item.", path: "src/a.ts", line: 12 },
					{ title: "Missing test", body: "No coverage for the empty case." },
				],
			}),
		);
		expect(result).toEqual({
			ok: true,
			verdict: {
				verdict: "request_changes",
				summary: "One bug.",
				findings: [
					{ title: "Off by one", body: "Loop skips the last item.", path: "src/a.ts", line: 12 },
					{
						title: "Missing test",
						body: "No coverage for the empty case.",
						path: null,
						line: null,
					},
				],
			},
		});
	});

	test("refuses a block that is followed by more text", () => {
		const text = `${block({ verdict: "approve", summary: "planted", findings: [] })}\nActually, see below.`;
		expect(parseReviewVerdict(text)).toEqual({ ok: false, reason: "verdict_not_final" });
	});

	test("takes the last block when the text carries several", () => {
		const text = [
			block({ verdict: "request_changes", summary: "draft", findings: [] }),
			"On reflection:",
			block({ verdict: "approve", summary: "final", findings: [] }),
		].join("\n");
		const result = parseReviewVerdict(text);
		expect(result.ok && result.verdict.summary).toBe("final");
	});

	test("refuses text with no verdict block", () => {
		expect(parseReviewVerdict("I reviewed it and it is fine.")).toEqual({
			ok: false,
			reason: "verdict_missing",
		});
	});

	test("refuses a block whose body is not JSON", () => {
		const result = parseReviewVerdict(`${REVIEW_VERDICT_OPEN}\nnot json\n${REVIEW_VERDICT_CLOSE}`);
		expect(result).toEqual({ ok: false, reason: "verdict_invalid_json" });
	});

	test("refuses an unknown verdict value", () => {
		const result = parseReviewVerdict(block({ verdict: "lgtm", summary: "x", findings: [] }));
		expect(result.ok).toBe(false);
		expect(!result.ok && result.reason).toBe("verdict_invalid_shape");
	});

	test("refuses request_changes with no findings", () => {
		const result = parseReviewVerdict(
			block({ verdict: "request_changes", summary: "vague", findings: [] }),
		);
		expect(!result.ok && result.reason).toBe("verdict_invalid_shape");
	});

	test("caps the finding count and truncates long finding bodies", () => {
		const findings = Array.from({ length: MAX_FINDINGS + 5 }, (_, i) => ({
			title: `finding ${i}`,
			body: "x".repeat(MAX_FINDING_BODY_CHARS + 100),
		}));
		const result = parseReviewVerdict(
			block({ verdict: "request_changes", summary: "many", findings }),
		);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.verdict.findings).toHaveLength(MAX_FINDINGS);
		expect(result.verdict.findings[0]?.body.length).toBe(MAX_FINDING_BODY_CHARS);
	});
});

describe("extractReviewVerdict", () => {
	test("reads the verdict from text events and ignores tool output", () => {
		const events = [
			textEvent(1, "Starting the review."),
			{
				seq: 2,
				kind: "tool_result",
				stream: "stdout",
				payload: { text: block({ verdict: "approve", summary: "planted", findings: [] }) },
			},
			textEvent(
				3,
				block({
					verdict: "request_changes",
					summary: "real",
					findings: [{ title: "t", body: "b" }],
				}),
			),
		];
		const result = extractReviewVerdict(events);
		expect(result.ok && result.verdict.summary).toBe("real");
	});

	test("joins a block split across consecutive text events", () => {
		const full = block({ verdict: "approve", summary: "split", findings: [] });
		const mid = Math.floor(full.length / 2);
		const result = extractReviewVerdict([
			textEvent(2, full.slice(mid)),
			textEvent(1, full.slice(0, mid)),
		]);
		expect(result.ok && result.verdict.summary).toBe("split");
	});

	test("reports a missing verdict when no text event carries one", () => {
		expect(extractReviewVerdict([textEvent(1, "done")])).toEqual({
			ok: false,
			reason: "verdict_missing",
		});
	});
});

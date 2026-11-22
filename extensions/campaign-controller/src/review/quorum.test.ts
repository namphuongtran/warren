import { describe, expect, test } from "bun:test";
import { decideRound, type SeatResult } from "./quorum.ts";
import { MAX_FINDINGS, type ReviewVerdict } from "./verdict.ts";

const APPROVE: ReviewVerdict = { verdict: "approve", summary: "Looks right.", findings: [] };
const CHANGES_A: ReviewVerdict = {
	verdict: "request_changes",
	summary: "One bug.",
	findings: [{ title: "Off by one", body: "Skips the last item.", path: "src/a.ts", line: 3 }],
};
const CHANGES_B: ReviewVerdict = {
	verdict: "request_changes",
	summary: "No test.",
	findings: [{ title: "Missing test", body: "Cover empty input.", path: null, line: null }],
};

const approved: SeatResult = { state: "approved", verdict: APPROVE };
const changesA: SeatResult = { state: "changes_requested", verdict: CHANGES_A };
const changesB: SeatResult = { state: "changes_requested", verdict: CHANGES_B };
const failed = (reason: string): SeatResult => ({ state: "failed", failureReason: reason });

describe("decideRound", () => {
	test("passes a lone seat's verdict through unchanged", () => {
		expect(decideRound([approved], 1)).toEqual({ outcome: "approved", verdict: APPROVE });
		expect(decideRound([changesA], 1)).toEqual({
			outcome: "changes_requested",
			verdict: CHANGES_A,
		});
	});

	test("keeps a lone seat's failure reason", () => {
		expect(decideRound([failed("run_failed")], 1)).toEqual({
			outcome: "failed",
			reason: "run_failed",
		});
	});

	test("approves when approvals reach the quorum despite a dissenting seat", () => {
		const decision = decideRound([approved, changesA, approved], 2);
		expect(decision.outcome).toBe("approved");
		if (decision.outcome !== "approved") return;
		expect(decision.verdict.verdict).toBe("approve");
		expect(decision.verdict.summary).toBe("2 of 3 reviewers approved (quorum 2).");
		// A dissent under an approval never feeds the fixer.
		expect(decision.verdict.findings).toEqual([]);
	});

	test("requests changes with every dissenting seat's findings when the quorum is missed", () => {
		const decision = decideRound([approved, changesA, changesB], 2);
		expect(decision).toEqual({
			outcome: "changes_requested",
			verdict: {
				verdict: "request_changes",
				summary: "2 of 3 reviewers requested changes; 1 approved (quorum 2).",
				findings: [...CHANGES_A.findings, ...CHANGES_B.findings],
			},
		});
	});

	test("lets a change request win over a failed seat when the quorum is missed", () => {
		const decision = decideRound([changesA, failed("verdict_missing")], 2);
		expect(decision.outcome).toBe("changes_requested");
	});

	test("fails closed when failed seats leave the quorum unmet and nobody objected", () => {
		expect(decideRound([approved, failed("run_failed")], 2)).toEqual({
			outcome: "failed",
			reason: "quorum_unmet",
		});
	});

	test("caps the combined findings by taking each seat's findings in turn", () => {
		const findingsFrom = (prefix: string): SeatResult => ({
			state: "changes_requested",
			verdict: {
				...CHANGES_A,
				findings: Array.from({ length: MAX_FINDINGS }, (_, i) => ({
					title: `${prefix}${i}`,
					body: "b",
					path: null,
					line: null,
				})),
			},
		});
		const decision = decideRound([findingsFrom("a"), findingsFrom("b")], 2);
		if (decision.outcome !== "changes_requested") throw new Error("expected changes_requested");
		const titles = decision.verdict.findings.map((finding) => finding.title);
		expect(titles).toHaveLength(MAX_FINDINGS);
		// A long first review cannot crowd out the second reviewer.
		expect(titles.slice(0, 4)).toEqual(["a0", "b0", "a1", "b1"]);
	});
});

/**
 * The reviewer-panel quorum rule (namphuongtran/warren#18, Phase 2). Pure: no I/O, no clock.
 *
 * Every seat of a round reviews the same SHA independently. Once every seat
 * has a result, the round is decided:
 *
 * 1. approvals >= quorum          → approved; dissenting findings stay in the
 *                                   comment and never reach the fixer.
 * 2. else any change request      → changes_requested, carrying every
 *                                   dissenting seat's findings, interleaved
 *                                   seat by seat and capped, so one long
 *                                   review cannot crowd out the others.
 * 3. else (only approvals and failures) → failed. Nothing approves by default.
 *
 * A one-seat panel passes its seat's verdict or failure reason through
 * unchanged, so Phase 1 behaviour is the degenerate case of this rule.
 */
import { MAX_FINDINGS, type ReviewVerdict } from "./verdict.ts";

/** One settled seat. */
export type SeatResult =
	| { readonly state: "approved" | "changes_requested"; readonly verdict: ReviewVerdict }
	| { readonly state: "failed"; readonly failureReason: string };

export type RoundDecision =
	| { readonly outcome: "approved" | "changes_requested"; readonly verdict: ReviewVerdict }
	| { readonly outcome: "failed"; readonly reason: string };

/** Failure reason of a multi-seat round that failed seats kept below its quorum. */
export const QUORUM_UNMET_REASON = "quorum_unmet";

export function decideRound(seats: readonly SeatResult[], quorum: number): RoundDecision {
	const [only] = seats;
	if (seats.length === 1 && only !== undefined) {
		return only.state === "failed"
			? { outcome: "failed", reason: only.failureReason }
			: { outcome: only.state, verdict: only.verdict };
	}
	const approvals = seats.filter((seat) => seat.state === "approved").length;
	const dissents = seats.flatMap((seat) =>
		seat.state === "changes_requested" ? [seat.verdict] : [],
	);
	if (approvals >= quorum) {
		return {
			outcome: "approved",
			verdict: {
				verdict: "approve",
				summary: `${approvals} of ${seats.length} reviewers approved (quorum ${quorum}).`,
				findings: [],
			},
		};
	}
	if (dissents.length > 0) {
		return {
			outcome: "changes_requested",
			verdict: {
				verdict: "request_changes",
				summary: `${dissents.length} of ${seats.length} reviewers requested changes; ${approvals} approved (quorum ${quorum}).`,
				findings: interleave(dissents.map((verdict) => verdict.findings)).slice(0, MAX_FINDINGS),
			},
		};
	}
	return { outcome: "failed", reason: QUORUM_UNMET_REASON };
}

/** Round-robin merge: the first item of each list, then the second of each, and so on. */
function interleave<T>(lists: ReadonlyArray<readonly T[]>): T[] {
	const longest = Math.max(0, ...lists.map((list) => list.length));
	const merged: T[] = [];
	for (let index = 0; index < longest; index += 1) {
		for (const list of lists) {
			const item = list[index];
			if (item !== undefined) merged.push(item);
		}
	}
	return merged;
}

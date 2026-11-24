import { describe, expect, test } from "bun:test";
import type { CheckRun } from "../forge/contract.ts";
import { FakeForge } from "../forge/fake/fake-forge.ts";
import { createPrChecksReader } from "./pr-check-summary.ts";

const PR_URL = "fake://acme/app/pulls/7";
const REF = { forge: "fake", key: "acme/app" };
const HEAD = "a".repeat(40);
const NOW = new Date("2026-11-21T10:00:00.000Z");

function check(name: string, status: CheckRun["status"], conclusion: string | null): CheckRun {
	return { name, status, conclusion, jobId: null, detailsUrl: null };
}

function reader(forge: FakeForge) {
	return createPrChecksReader({ forge, now: () => NOW });
}

describe("createPrChecksReader", () => {
	test("reports passing when every check completed without a failure", async () => {
		const forge = new FakeForge();
		forge.setChecks(REF, HEAD, [
			check("lint", "completed", "success"),
			check("docs", "completed", "skipped"),
		]);
		expect(await reader(forge)(PR_URL, HEAD)).toEqual({
			state: "passing",
			failing: [],
			commit: HEAD,
			checkedAt: NOW.toISOString(),
		});
	});

	test("reports failing with the names of the checks that failed", async () => {
		const forge = new FakeForge();
		forge.setChecks(REF, HEAD, [
			check("Images, booted backend, authenticated e2e", "completed", "failure"),
			check("lint", "completed", "success"),
			check("deploy preview", "completed", "timed_out"),
		]);
		const read = await reader(forge)(PR_URL, HEAD);
		expect(read?.state).toBe("failing");
		expect(read?.failing).toEqual(["Images, booted backend, authenticated e2e", "deploy preview"]);
	});

	test("reports none, without asking, when the forge cannot read checks", async () => {
		const forge = new FakeForge();
		forge.capabilities.checkRuns = false;
		let asked = 0;
		forge.listChecks = async () => {
			asked += 1;
			return { ok: false, error: { kind: "unsupported", detail: "no Checks API" } };
		};
		expect(await reader(forge)(PR_URL, HEAD)).toEqual({
			state: "none",
			failing: [],
			commit: HEAD,
			checkedAt: NOW.toISOString(),
		});
		expect(asked).toBe(0);
	});

	test("reports none when the forge answers that it cannot read checks", async () => {
		const forge = new FakeForge();
		forge.listChecks = async () => ({
			ok: false,
			error: { kind: "unsupported", detail: "no Checks API" },
		});
		expect((await reader(forge)(PR_URL, HEAD))?.state).toBe("none");
	});

	test("stores nothing when the forge read fails, so the last read stands", async () => {
		const forge = new FakeForge();
		forge.listChecks = async () => ({
			ok: false,
			error: { kind: "rate_limited", detail: "slow down" },
		});
		expect(await reader(forge)(PR_URL, HEAD)).toBeNull();
	});

	test("carries the warren/review verdict on the head commit, ignoring other statuses", async () => {
		const forge = new FakeForge();
		forge.setChecks(REF, HEAD, [check("lint", "completed", "success")]);
		forge.setCommitStatuses(REF, HEAD, [
			{ context: "deploy/preview", state: "failure", description: "down" },
			{
				context: "warren/review",
				state: "success",
				description: "Approved by the reviewer",
			},
		]);
		expect(await reader(forge)(PR_URL, HEAD)).toEqual({
			state: "passing",
			failing: [],
			commit: HEAD,
			checkedAt: NOW.toISOString(),
			review: { state: "approved", description: "Approved by the reviewer" },
		});
	});

	test("maps each review status state to a verdict", async () => {
		const cases = [
			["failure", "changes_requested"],
			["pending", "pending"],
			["error", "failed"],
		] as const;
		for (const [status, verdict] of cases) {
			const forge = new FakeForge();
			forge.setCommitStatuses(REF, HEAD, [
				{ context: "warren/review", state: status, description: null },
			]);
			expect((await reader(forge)(PR_URL, HEAD))?.review).toEqual({
				state: verdict,
				description: null,
			});
		}
	});

	test("carries the review when the forge cannot read checks", async () => {
		const forge = new FakeForge();
		forge.capabilities.checkRuns = false;
		forge.setCommitStatuses(REF, HEAD, [
			{ context: "warren/review", state: "success", description: null },
		]);
		const read = await reader(forge)(PR_URL, HEAD);
		expect(read?.state).toBe("none");
		expect(read?.review?.state).toBe("approved");
	});

	test("does not ask for statuses when the forge cannot read them", async () => {
		const forge = new FakeForge();
		forge.capabilities.commitStatuses = false;
		let asked = 0;
		forge.listCommitStatuses = async () => {
			asked += 1;
			return { ok: true, value: [] };
		};
		const read = await reader(forge)(PR_URL, HEAD);
		expect(read?.state).toBe("none");
		expect(read?.review).toBeUndefined();
		expect(asked).toBe(0);
	});

	test("stores the checks without a review when the credential cannot read statuses", async () => {
		const forge = new FakeForge();
		forge.setChecks(REF, HEAD, [check("lint", "completed", "success")]);
		forge.listCommitStatuses = async () => ({
			ok: false,
			error: { kind: "forbidden", detail: "Resource not accessible by integration" },
		});
		const read = await reader(forge)(PR_URL, HEAD);
		expect(read?.state).toBe("passing");
		expect(read?.review).toBeUndefined();
	});

	test("keeps the checks and the last review of the same commit when the status read fails transiently", async () => {
		const forge = new FakeForge();
		forge.setChecks(REF, HEAD, [check("lint", "completed", "success")]);
		forge.listCommitStatuses = async () => ({
			ok: false,
			error: { kind: "network", detail: "socket hang up" },
		});
		const previous = {
			state: "pending" as const,
			failing: [],
			commit: HEAD,
			checkedAt: "2026-11-21T09:00:00.000Z",
			review: { state: "pending" as const, description: "Review in progress" },
		};
		const read = await reader(forge)(PR_URL, HEAD, previous);
		expect(read?.state).toBe("passing");
		expect(read?.review).toEqual({ state: "pending", description: "Review in progress" });
		const moved = await reader(forge)(PR_URL, HEAD, { ...previous, commit: "b".repeat(40) });
		expect(moved?.state).toBe("passing");
		expect(moved?.review).toBeUndefined();
	});
});

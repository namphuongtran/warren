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
});

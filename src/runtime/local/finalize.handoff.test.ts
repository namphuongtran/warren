/**
 * `LocalProvider.finalize()` collects the agent's handoff report
 * (namphuongtran/warren#21). The Docker provider runs the same host-side
 * finalize, so this covers both.
 */

import { describe, expect, test } from "bun:test";
import { RUN_APPROACH_MAX_BYTES, RUN_HANDOFF_MAX_BYTES } from "../../core/wire.ts";
import { fakeBurrowClient, fakeExec, fakeFs, makeBurrow } from "../../runs/reap/test-helpers.ts";
import type { FinalizeIntent, RunHandle } from "../contract.ts";

const WS = "/data/sandbox/ws";
const HANDLE: RunHandle = {
	runId: "run_domain0001",
	sandboxId: "bur_aaaaaaaaaaaa",
	providerRunId: "run_zzzzzzzzzzzz",
};
const INTENT: FinalizeIntent = { branch: "warren/run-1", push: true, artifacts: [] };

async function finalizeWith(files: Record<string, string>) {
	const fs = fakeFs(files);
	const client = fakeBurrowClient(makeBurrow({ workspacePath: WS }), {});
	return client.withFinalizeSeams(fs.fs, fakeExec().exec).finalize(HANDLE, INTENT);
}

describe("finalize — handoff collection", () => {
	test("returns the workspace .warren/handoff.json body", async () => {
		const body = '{"status":"done","summary":"Shipped it."}';
		const result = await finalizeWith({ [`${WS}/.warren/handoff.json`]: body });
		expect(result.handoffBody).toBe(body);
	});

	test("returns null when the run wrote no handoff", async () => {
		const result = await finalizeWith({});
		expect(result.handoffBody).toBeNull();
	});

	test("clips an oversized body so it still reads as over the cap", async () => {
		const body = "x".repeat(RUN_HANDOFF_MAX_BYTES * 4);
		const result = await finalizeWith({ [`${WS}/.warren/handoff.json`]: body });
		expect(result.handoffBody?.length).toBe(RUN_HANDOFF_MAX_BYTES + 1);
	});
});

describe("finalize — approach note collection (namphuongtran/warren#33)", () => {
	test("returns the workspace .warren/approach.md body", async () => {
		const body = "## Understanding\nFix the typo.";
		const result = await finalizeWith({ [`${WS}/.warren/approach.md`]: body });
		expect(result.approachBody).toBe(body);
	});

	test("returns null when the run wrote no approach note", async () => {
		const result = await finalizeWith({});
		expect(result.approachBody).toBeNull();
	});

	test("clips an oversized note past the cap", async () => {
		const body = "x".repeat(RUN_APPROACH_MAX_BYTES * 4);
		const result = await finalizeWith({ [`${WS}/.warren/approach.md`]: body });
		expect(result.approachBody?.length).toBe(RUN_APPROACH_MAX_BYTES + 1);
	});
});

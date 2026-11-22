/**
 * Reading a `dispatch.quota_held` payload back (namphuongtran/warren#30). The
 * payload is replayed as a dispatch request at the release, so a damaged or
 * hand-edited one must read as unusable or drop the bad field, never pass
 * through as a request it does not describe.
 */

import { describe, expect, test } from "bun:test";
import { readHeldDecision } from "./hold.ts";

const REQUEST = { agentName: "claude-code", projectId: "prj_1", prompt: "go" };
const VALID = { resetsAt: 1795338600, releaseAt: "2026-11-22T09:11:30.000Z", request: REQUEST };

describe("readHeldDecision", () => {
	test("reads a well-formed payload", () => {
		expect(readHeldDecision(VALID)).toEqual(VALID);
	});

	test("rejects a payload that is not an object", () => {
		for (const payload of [null, "held", 42, []]) {
			expect(readHeldDecision(payload)).toBeNull();
		}
	});

	test("rejects a non-finite or missing resetsAt", () => {
		for (const resetsAt of [Number.NaN, Number.POSITIVE_INFINITY, "1795338600", undefined]) {
			expect(readHeldDecision({ ...VALID, resetsAt })).toBeNull();
		}
	});

	test("rejects an unparseable releaseAt", () => {
		expect(readHeldDecision({ ...VALID, releaseAt: "soon" })).toBeNull();
	});

	test("rejects a request missing the agent, project or prompt", () => {
		for (const field of ["agentName", "projectId", "prompt"]) {
			const request: Record<string, unknown> = { ...REQUEST };
			delete request[field];
			expect(readHeldDecision({ ...VALID, request })).toBeNull();
		}
		expect(readHeldDecision({ ...VALID, request: { ...REQUEST, prompt: 7 } })).toBeNull();
	});

	test("drops a field of the wrong type or outside its vocabulary", () => {
		const decision = readHeldDecision({
			...VALID,
			request: {
				...REQUEST,
				mode: "conversation",
				cloneKind: "fork",
				dispatchOrigin: "elsewhere",
				maxCostUsdOverride: Number.NaN,
				ref: 12,
				newBranch: "feat/x",
			},
		});

		expect(decision?.request).toEqual({ ...REQUEST, newBranch: "feat/x" });
	});

	test("ignores fields a dispatch request does not have", () => {
		const decision = readHeldDecision({
			...VALID,
			request: { ...REQUEST, force: true, gitCredential: { token: "x" } },
		});

		expect(decision?.request).toEqual(REQUEST);
	});
});

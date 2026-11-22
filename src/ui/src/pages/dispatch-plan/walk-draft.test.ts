import { describe, expect, test } from "bun:test";
import { buildCreatePlanRunInput, initialWalkDraft, type WalkDraft } from "./walk-draft.ts";

function draftWith(overrides: Partial<WalkDraft>): WalkDraft {
	return { ...initialWalkDraft({}), project: "warren", agent: "claude-code", ...overrides };
}

describe("buildCreatePlanRunInput", () => {
	test("omits an auto-filled provider the operator never touched (namphuongtran/warren#43)", () => {
		const body = buildCreatePlanRunInput({
			draft: draftWith({
				planId: "pl-1234",
				providerOverride: "openrouter",
				modelOverride: "claude-opus-5-5",
			}),
			providerTouched: false,
			maxCostUsd: undefined,
		});

		expect(body.providerOverride).toBeUndefined();
		expect(body.modelOverride).toBe("claude-opus-5-5");
	});

	test("sends a provider the operator typed", () => {
		const body = buildCreatePlanRunInput({
			draft: draftWith({ planId: "pl-1234", providerOverride: "openrouter" }),
			providerTouched: true,
			maxCostUsd: undefined,
		});

		expect(body.providerOverride).toBe("openrouter");
	});
});

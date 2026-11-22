import { describe, expect, test } from "bun:test";
import { buildCreateRunInput, type DispatchDraft, initialDraft } from "./dispatch-draft.ts";

function draftWith(overrides: Partial<DispatchDraft>): DispatchDraft {
	return { ...initialDraft({}), project: "warren", agent: "claude-code", ...overrides };
}

describe("buildCreateRunInput", () => {
	test("omits an auto-filled provider the operator never touched (namphuongtran/warren#43)", () => {
		const body = buildCreateRunInput({
			draft: draftWith({ providerOverride: "openrouter", modelOverride: "claude-opus-5-5" }),
			providerTouched: false,
			routeState: {},
			maxCostUsd: undefined,
		});

		expect(body.providerOverride).toBeUndefined();
		expect(body.modelOverride).toBe("claude-opus-5-5");
	});

	test("sends a provider the operator typed", () => {
		const body = buildCreateRunInput({
			draft: draftWith({ providerOverride: " openrouter ", modelOverride: "claude-opus-5-5" }),
			providerTouched: true,
			routeState: {},
			maxCostUsd: undefined,
		});

		expect(body.providerOverride).toBe("openrouter");
	});
});

import { describe, expect, test } from "bun:test";

import { PUBLIC_AGENT_FIELDS } from "../../../src/server/handlers/agents.ts";
import {
	PUBLIC_PLAN_RUN_CHILD_FIELDS,
	PUBLIC_PLAN_RUN_FIELDS,
} from "../../../src/server/handlers/plan-runs-projection.ts";
import { PUBLIC_PROJECT_FIELDS } from "../../../src/server/handlers/projects.ts";
import {
	PUBLIC_WARREN_CONFIG_DEFAULTS_FIELDS,
	PUBLIC_WARREN_CONFIG_FIELDS,
} from "../../../src/server/handlers/projects.warren-config.ts";
import {
	PUBLIC_COST_PER_MERGED_PR_BUCKET_FIELDS,
	PUBLIC_COST_PER_MERGED_PR_OVERALL_FIELDS,
	PUBLIC_RUN_ANALYTICS_FIELDS,
	PUBLIC_RUN_GROUP_FIELDS,
	PUBLIC_RUN_TOTALS_FIELDS,
} from "../../../src/server/handlers/runs/analytics.projection.ts";
import {
	PUBLIC_CONTEXT_WASTE_FIELDS,
	PUBLIC_CONTEXT_WASTE_SHARE_FIELDS,
} from "../../../src/server/handlers/runs/analytics-waste.ts";
import { PUBLIC_RUN_FIELDS } from "../../../src/server/handlers/runs/lifecycle.ts";
import { FORBIDDEN_FIELD_NAMES } from "./39-public-exposure.helpers.ts";
import { assertNoLeak } from "./39-public-exposure.leaks.ts";

const PUBLIC_FIELD_LISTS: Readonly<Record<string, readonly string[]>> = {
	PUBLIC_RUN_FIELDS,
	PUBLIC_PROJECT_FIELDS,
	PUBLIC_AGENT_FIELDS,
	PUBLIC_PLAN_RUN_FIELDS,
	PUBLIC_PLAN_RUN_CHILD_FIELDS,
	PUBLIC_WARREN_CONFIG_FIELDS,
	PUBLIC_WARREN_CONFIG_DEFAULTS_FIELDS,
	PUBLIC_RUN_ANALYTICS_FIELDS,
	PUBLIC_RUN_TOTALS_FIELDS,
	PUBLIC_RUN_GROUP_FIELDS,
	PUBLIC_COST_PER_MERGED_PR_BUCKET_FIELDS,
	PUBLIC_COST_PER_MERGED_PR_OVERALL_FIELDS,
	PUBLIC_CONTEXT_WASTE_FIELDS,
	PUBLIC_CONTEXT_WASTE_SHARE_FIELDS,
};

describe("assertNoLeak", () => {
	test("passes a public field whose name extends a redacted one", () => {
		// namphuongtran/warren#118: qualityGateOutcome is public, qualityGate is not.
		const body = JSON.stringify([{ id: "r1", qualityGateOutcome: "passed" }]);
		expect(() => assertNoLeak("GET /runs", body)).not.toThrow();
	});

	test("refuses a redacted field present as a JSON key", () => {
		const body = JSON.stringify([{ id: "r1", qualityGate: "x", qualityGateOutcome: null }]);
		expect(() => assertNoLeak("GET /runs", body)).toThrow(/"qualityGate"/);
	});

	test("refuses a redacted field nested in a JSON-encoded string", () => {
		// A leak can arrive escaped inside a string value (an event payload,
		// a rendered JSON blob), not only as a top-level key.
		const body = JSON.stringify({ payload: JSON.stringify({ resolvedFrom: "x" }) });
		expect(() => assertNoLeak("GET /agents", body)).toThrow(/"resolvedFrom"/);
	});

	test("lets no public projection field trip the redacted-name scan", () => {
		for (const [list, fields] of Object.entries(PUBLIC_FIELD_LISTS)) {
			for (const field of fields) {
				const body = JSON.stringify({ [field]: null });
				expect(() => assertNoLeak(`${list}.${field}`, body)).not.toThrow();
			}
		}
	});
});

describe("FORBIDDEN_FIELD_NAMES", () => {
	test("holds only plain identifiers so the whole-name scan stays exact", () => {
		for (const name of FORBIDDEN_FIELD_NAMES) {
			expect(name).toMatch(/^[A-Za-z_$][A-Za-z0-9_$]*$/);
		}
	});
});

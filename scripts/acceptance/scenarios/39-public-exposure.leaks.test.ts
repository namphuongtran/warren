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
import {
	assertAnalyticsRollupsAbsent,
	assertNoLeak,
	assertPlanRunFailureReasonAbsent,
} from "./39-public-exposure.leaks.ts";
import { FORBIDDEN_FIELD_NAMES, SENTINELS } from "./39-public-exposure.vocabulary.ts";

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

	test("ignores a sandbox handle the scrubber already censored", () => {
		const body = JSON.stringify({ sandboxId: "[redacted]", sandboxRunId: "[redacted]" });
		expect(() => assertNoLeak("GET /events", body)).not.toThrow();
	});

	test("refuses a planted sentinel value and quotes the bytes around it", () => {
		const body = JSON.stringify({ note: `prefix ${SENTINELS.runWorkerId} suffix` });
		expect(() => assertNoLeak("GET /runs/r1", body)).toThrow(/runWorkerId sentinel.*prefix/);
	});

	test("refuses a host path fragment", () => {
		const body = JSON.stringify({ message: "clone failed in /data/projects/p1" });
		expect(() => assertNoLeak("GET /projects", body)).toThrow(/host path fragment "\/data\/"/);
	});

	test("refuses a live bearer and allows a redacted one", () => {
		const live = JSON.stringify({ header: "Bearer abcdefghijklmnop0123" });
		expect(() => assertNoLeak("GET /events", live)).toThrow(/unredacted bearer/);
		const redacted = JSON.stringify({ header: "Bearer [redacted]" });
		expect(() => assertNoLeak("GET /events", redacted)).not.toThrow();
	});

	test("refuses a forge-private fragment", () => {
		const body = JSON.stringify({ webUrl: "fake://warren-acceptance/repo" });
		expect(() => assertNoLeak("GET /runs", body)).toThrow(/forge-private fragment "fake:\/\/"/);
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

/** A spectator `GET /analytics/runs` body with every USD rollup already dropped. */
function cleanAnalyticsBody(): Record<string, unknown> {
	const bucket = { key: "claude-code", runs: 1 };
	return {
		totals: { runs: 1 },
		byAgent: [bucket],
		byModel: [bucket],
		byProvider: [bucket],
		outcomes: {
			costPerMergedPr: {
				overall: { mergedPrs: 1 },
				byAgent: [bucket],
				byModel: [bucket],
				byProvider: [bucket],
			},
		},
	};
}

describe("assertAnalyticsRollupsAbsent", () => {
	test("passes a body with every redacted rollup dropped", () => {
		expect(() => assertAnalyticsRollupsAbsent(cleanAnalyticsBody())).not.toThrow();
	});

	test("refuses a redacted totals field", () => {
		const body = { ...cleanAnalyticsBody(), totals: { runs: 1, costUsd: 3 } };
		expect(() => assertAnalyticsRollupsAbsent(body)).toThrow(/totals\.costUsd is redacted/);
	});

	test("refuses a redacted field in a group bucket", () => {
		const body = { ...cleanAnalyticsBody(), byModel: [{ key: "m", priced: true }] };
		expect(() => assertAnalyticsRollupsAbsent(body)).toThrow(/byModel\[\]\.priced/);
	});

	test("refuses a redacted cost-per-merged-PR field", () => {
		const body = cleanAnalyticsBody();
		const outcomes = body.outcomes as { costPerMergedPr: Record<string, unknown> };
		outcomes.costPerMergedPr.byAgent = [{ key: "a", costPerMergedPrUsd: 2 }];
		expect(() => assertAnalyticsRollupsAbsent(body)).toThrow(
			/outcomes\.costPerMergedPr\.byAgent\[\]\.costPerMergedPrUsd/,
		);
	});

	test("fails loudly on a missing object or a non-array group", () => {
		const noTotals = { ...cleanAnalyticsBody(), totals: null };
		expect(() => assertAnalyticsRollupsAbsent(noTotals)).toThrow(/expected a `totals` object/);
		const flatGroup = { ...cleanAnalyticsBody(), byAgent: {} };
		expect(() => assertAnalyticsRollupsAbsent(flatGroup)).toThrow(/`byAgent` to be an array/);
	});
});

describe("assertPlanRunFailureReasonAbsent", () => {
	test("passes plan-run bodies without the key", () => {
		const body = [{ id: "pr1", children: [{ id: "c1", status: "failed" }] }, "text", 3];
		expect(() => assertPlanRunFailureReasonAbsent("GET /plan-runs", body)).not.toThrow();
	});

	test("refuses the key on a nested child", () => {
		const body = { id: "pr1", children: [{ id: "c1", failureReason: null }] };
		expect(() => assertPlanRunFailureReasonAbsent("GET /plan-runs/pr1", body)).toThrow(
			/GET \/plan-runs\/pr1: a plan-run body carries failureReason/,
		);
	});
});

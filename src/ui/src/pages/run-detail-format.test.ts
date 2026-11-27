import { describe, expect, test } from "bun:test";
import type { RunEvent, RunRow } from "@/api/types.ts";
import {
	extractQuotaHold,
	extractReapSummary,
	findFirstText,
	findToolUseName,
	formatContextUse,
	formatCostUsd,
	formatTokenBreakdown,
	formatTokens,
	formatWallClock,
	isBridgeStalled,
	readCostTotal,
	readNumber,
	readString,
	toolStallSummary,
	truncateSummary,
} from "./run-detail-format.ts";

describe("formatCostUsd", () => {
	test("formats sub-dollar costs with three decimals", () => {
		expect(formatCostUsd(0.005)).toBe("$0.005");
	});

	test("formats zero as $0.00", () => {
		expect(formatCostUsd(0)).toBe("$0.00");
	});

	test("formats dollar-and-up costs with two decimals", () => {
		expect(formatCostUsd(1.234)).toBe("$1.23");
	});

	test("warren-17d7: returns the em-dash for null and undefined", () => {
		// The spectator projection strips maxCostUsd
		// (REDACTED_PLAN_RUN_FIELDS), so callers see undefined — that used
		// to throw `toFixed of undefined`.
		expect(formatCostUsd(null)).toBe("—");
		expect(formatCostUsd(undefined)).toBe("—");
	});
});

describe("formatTokens", () => {
	test("formats small, thousands, and millions", () => {
		expect(formatTokens(42)).toBe("42");
		expect(formatTokens(1234)).toBe("1.2k");
		expect(formatTokens(2_500_000)).toBe("2.5M");
	});
});

describe("formatTokenBreakdown", () => {
	test("joins present counters and drops absent / zero ones", () => {
		expect(
			formatTokenBreakdown({
				tokensInput: 1000,
				tokensOutput: 2000,
				tokensCacheRead: 0,
				tokensCacheWrite: null,
			} as unknown as RunRow),
		).toBe("1.0k in · 2.0k out");
		expect(
			formatTokenBreakdown({
				tokensInput: null,
				tokensOutput: null,
				tokensCacheRead: null,
				tokensCacheWrite: null,
			} as unknown as RunRow),
		).toBe(null);
	});
});

describe("formatContextUse (namphuongtran/warren#20)", () => {
	test("shows the share of the window the conversation holds, then both counts", () => {
		const run = { contextTokens: 165_000, contextWindowTokens: 200_000 } as RunRow;
		expect(formatContextUse(run)).toBe("83% · 165.0k of 200.0k");
	});

	test("reads a 1M window in millions", () => {
		const run = { contextTokens: 400_000, contextWindowTokens: 1_000_000 } as RunRow;
		expect(formatContextUse(run)).toBe("40% · 400.0k of 1.0M");
	});

	test("returns null with no reading, or for a spectator who gets no overlay", () => {
		expect(formatContextUse({ contextTokens: null, contextWindowTokens: null } as RunRow)).toBe(
			null,
		);
		expect(formatContextUse({} as RunRow)).toBe(null);
	});
});

describe("formatWallClock", () => {
	test("extracts HH:MM:SS from ISO, else returns the raw string", () => {
		expect(formatWallClock("2026-09-03T10:05:30.123Z")).toBe("10:05:30");
		expect(formatWallClock("not-a-timestamp")).toBe("not-a-timestamp");
	});
});

describe("truncateSummary", () => {
	test("passes short strings through and ellipsizes long ones", () => {
		expect(truncateSummary("short")).toBe("short");
		const long = "x".repeat(200);
		expect(truncateSummary(long)).toBe(`${"x".repeat(139)}…`);
	});
});

describe("readString / readNumber", () => {
	test("narrow to the declared type, else null", () => {
		expect(readString("a")).toBe("a");
		expect(readString(5)).toBe(null);
		expect(readNumber(5)).toBe(5);
		expect(readNumber("5")).toBe(null);
	});
});

describe("readCostTotal", () => {
	test("reads a numeric total off an object payload", () => {
		expect(readCostTotal({ total: 1.5 })).toBe(1.5);
		expect(readCostTotal({ total: "1.5" })).toBe(null);
		expect(readCostTotal(2)).toBe(2);
		expect(readCostTotal(null)).toBe(null);
		expect(readCostTotal([1])).toBe(null);
	});
});

describe("extractReapSummary", () => {
	test("returns the latest reap.completed payload", () => {
		const events = [
			{ kind: "state_change", payload: null },
			{ kind: "reap.completed", payload: { branchPushed: true } },
			{ kind: "state_change", payload: null },
		] as unknown as RunEvent[];
		expect(extractReapSummary(events)).toEqual({ branchPushed: true });
	});

	test("returns null for a malformed payload or no reap event", () => {
		expect(
			extractReapSummary([{ kind: "reap.completed", payload: "junk" } as unknown as RunEvent[]]),
		).toBe(null);
		expect(
			extractReapSummary([{ kind: "state_change", payload: null } as unknown as RunEvent[]]),
		).toBe(null);
	});
});

describe("isBridgeStalled", () => {
	test("true on a stall not yet recovered, false otherwise", () => {
		expect(isBridgeStalled([{ kind: "bridge_stalled" } as unknown as RunEvent])).toBe(true);
		expect(
			isBridgeStalled([
				{ kind: "bridge_stalled" } as unknown as RunEvent,
				{ kind: "bridge_recovered" } as unknown as RunEvent,
			]),
		).toBe(false);
		expect(isBridgeStalled([])).toBe(false);
	});
});

describe("findToolUseName / findFirstText", () => {
	test("find the first tool_use name in a content array", () => {
		expect(findToolUseName([{ type: "tool_use", name: "bash" }])).toBe("bash");
		expect(findToolUseName([{ type: "text" }])).toBe(null);
		expect(findToolUseName("junk")).toBe(null);
	});

	test("find the first text across string and array content", () => {
		expect(findFirstText("plain")).toBe("plain");
		expect(findFirstText([{ type: "text", text: "hello" }, "alt"])).toBe("hello");
		expect(findFirstText([{ type: "text" }])).toBe(null);
		expect(findFirstText(null)).toBe(null);
	});
});

describe("extractQuotaHold", () => {
	const event = (seq: number, kind: string, payload: unknown = {}): RunEvent => ({
		id: seq,
		runId: "run-held",
		seq,
		ts: "2026-11-22T08:50:43.000Z",
		kind,
		stream: "system",
		payload,
	});
	const held = event(1, "dispatch.quota_held", {
		reason: "provider_quota_exhausted",
		resetsAt: 1795338600,
		releaseAt: "2026-11-22T09:11:30.000Z",
	});

	test("reads the release time of a run still held", () => {
		expect(extractQuotaHold([held])).toEqual({ releaseAt: "2026-11-22T09:11:30.000Z" });
	});

	test("returns null once the hold is released", () => {
		expect(extractQuotaHold([held, event(2, "dispatch.quota_released")])).toBeNull();
	});

	test("returns null for a held payload without a readable release time", () => {
		for (const payload of [null, "held", { releaseAt: 1795338720 }]) {
			expect(extractQuotaHold([event(1, "dispatch.quota_held", payload)])).toBeNull();
		}
	});

	test("returns null for a run that was never held", () => {
		expect(extractQuotaHold([event(1, "state_change")])).toBeNull();
	});
});

describe("toolStallSummary", () => {
	const stall = {
		toolUseId: "toolu_1",
		toolName: "Bash",
		command: "uv run pytest -q",
		openedAt: "2026-11-22T10:05:00.000Z",
		warnedAt: "2026-11-22T10:20:00.000Z",
	};
	const at = (iso: string) => Date.parse(iso);

	test("names the tool and how long it has been open, in whole minutes", () => {
		expect(toolStallSummary(stall, at("2026-11-22T10:30:40.000Z"))).toBe(
			"Bash has been running for 25 min with no result.",
		);
	});

	test("falls back to a generic subject when the harness gave no tool name", () => {
		expect(toolStallSummary({ ...stall, toolName: null }, at("2026-11-22T11:05:00.000Z"))).toBe(
			"A tool call has been running for 60 min with no result.",
		);
	});
});

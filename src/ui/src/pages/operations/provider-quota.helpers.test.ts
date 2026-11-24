import { describe, expect, test } from "bun:test";
import type { ProviderQuotaView } from "@/api/ops-types.ts";
import { providerQuotaNotices } from "./provider-quota.helpers.ts";

// The live evidence of namphuongtran/warren#30: the five-hour window reopened
// at 09:10:00Z (unix 1795338600).
const RESETS_AT = 1795338600;
const RESET_MS = RESETS_AT * 1000;
const MINUTE = 60_000;
const clock = (iso: string) => `[${iso}]`;

function quota(overrides: Partial<ProviderQuotaView>): ProviderQuotaView {
	return {
		provider: "anthropic",
		credentialFingerprint: "3f9a1c0b7d2e4a61",
		status: "rejected",
		utilization: 1,
		rateLimitType: "five_hour",
		resetsAt: RESETS_AT,
		source: "rate_limit_event",
		sourceRunId: "run_jy2cxd7cmg9f",
		observedAt: "2026-11-22T08:50:31.000Z",
		exhausted: true,
		retryAfterSeconds: 1500,
		...overrides,
	};
}

describe("providerQuotaNotices", () => {
	test("warns that a spent window holds new runs until the reset", () => {
		const [notice] = providerQuotaNotices([quota({})], RESET_MS - 25 * MINUTE, clock);

		expect(notice?.variant).toBe("warning");
		expect(notice?.title).toBe("Provider usage limit reached");
		expect(notice?.detail).toBe(
			"The anthropic five-hour window reopens at [2026-11-22T09:10:00.000Z] (in 25m). " +
				"Scheduled runs wait and start after the reset, and stopped runs resume. " +
				"A manual dispatch is refused unless you hold it or force it.",
		);
	});

	test("informs when the provider warns that the window is nearly used", () => {
		const warned = quota({ status: "allowed_warning", utilization: 0.92, exhausted: false });

		const [notice] = providerQuotaNotices([warned], RESET_MS - 65 * MINUTE, clock);

		expect(notice?.variant).toBe("info");
		expect(notice?.title).toBe("Provider usage nearly spent");
		expect(notice?.detail).toBe(
			"The anthropic five-hour window is 92% used. It resets at [2026-11-22T09:10:00.000Z] (in 1h 05m).",
		);
	});

	test("says nothing for an open window, a past reset, or a report without one", () => {
		const now = RESET_MS - 10 * MINUTE;
		const rows = [
			quota({ status: "allowed", utilization: 0.4, exhausted: false }),
			quota({ status: "allowed_warning", resetsAt: RESETS_AT - 3600, exhausted: false }),
			quota({ status: "allowed_warning", resetsAt: null, exhausted: false }),
		];

		expect(providerQuotaNotices(rows, now, clock)).toEqual([]);
		expect(providerQuotaNotices([quota({})], RESET_MS + MINUTE, clock)).toEqual([]);
	});

	test("names the credential when one provider has several", () => {
		const rows = [quota({}), quota({ credentialFingerprint: "77aa0e91c2d3b4f5" })];

		const notices = providerQuotaNotices(rows, RESET_MS - MINUTE, clock);

		expect(notices[0]?.detail).toStartWith("The anthropic five-hour window (credential 3f9a1c) ");
		expect(notices[1]?.detail).toStartWith("The anthropic five-hour window (credential 77aa0e) ");
		expect(new Set(notices.map((n) => n.key)).size).toBe(2);
	});
});

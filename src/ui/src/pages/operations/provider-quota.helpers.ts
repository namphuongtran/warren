import type { ProviderQuotaView } from "@/api/ops-types.ts";
// Relative, not `@/`: the repo-root `bun test` resolves no `@/` alias for
// value imports (mx-2e4a1a rule).
import { PROVIDER_QUOTA_WARNING } from "../../../../core/wire.ts";
import { formatWaitMs } from "../../lib/format-wait.ts";

/**
 * The provider usage notices on the Operations page (namphuongtran/warren#30),
 * from `GET /provider-quota`. Pure, so the copy is testable without a DOM.
 *
 * A spent window (`exhausted`) and a window past the deployment's dispatch
 * threshold (`thresholdReached`) are warnings: Warren holds scheduled runs
 * and refuses dispatches from the UI on that credential until the reset. A
 * window the provider flags as nearly used is information. Every other
 * report says nothing, and so does a report whose reset has passed: the
 * window reopened even if no new report arrived.
 */

export interface ProviderQuotaNotice {
	readonly key: string;
	readonly variant: "warning" | "info";
	readonly title: string;
	readonly detail: string;
}

const UNTIL_RESET =
	"Scheduled runs wait and start after the reset. " +
	"A dispatch from the UI is refused until then; the warren CLI can hold one with --hold-on-quota.";

/** "five-hour" from `five_hour`; "usage" when the provider named no window. */
function windowLabel(rateLimitType: string | null): string {
	return rateLimitType === null ? "usage" : rateLimitType.replaceAll("_", "-");
}

const percent = (share: number): string => `${Math.round(share * 100)}%`;

function subjectOf(row: ProviderQuotaView, named: boolean): string {
	const credential = named ? ` (credential ${row.credentialFingerprint.slice(0, 6)})` : "";
	return `The ${row.provider} ${windowLabel(row.rateLimitType)} window${credential}`;
}

function usedOf(row: ProviderQuotaView): string {
	return row.utilization === null ? "nearly used" : `${percent(row.utilization)} used`;
}

/** The notice one credential's report calls for now, or null. */
function noticeOf(row: ProviderQuotaView, subject: string, at: string): ProviderQuotaNotice | null {
	const key = `${row.provider}:${row.credentialFingerprint}`;
	if (row.exhausted) {
		return {
			key,
			variant: "warning",
			title: "Provider usage limit reached",
			detail: `${subject} reopens at ${at}. Stopped runs resume after the reset. ${UNTIL_RESET}`,
		};
	}
	if (row.thresholdReached && row.maxUtilization !== null) {
		const past = `at or past the ${percent(row.maxUtilization)} threshold for new runs`;
		return {
			key,
			variant: "warning",
			title: "New runs paused at the usage threshold",
			detail: `${subject} is ${usedOf(row)}, ${past}. It resets at ${at}. ${UNTIL_RESET}`,
		};
	}
	if (row.status !== PROVIDER_QUOTA_WARNING) return null;
	return {
		key,
		variant: "info",
		title: "Provider usage nearly spent",
		detail: `${subject} is ${usedOf(row)}. It resets at ${at}.`,
	};
}

export function providerQuotaNotices(
	quotas: readonly ProviderQuotaView[],
	now: number,
	formatClock: (iso: string) => string,
): ProviderQuotaNotice[] {
	const perProvider = new Map<string, number>();
	for (const row of quotas) perProvider.set(row.provider, (perProvider.get(row.provider) ?? 0) + 1);
	const notices: ProviderQuotaNotice[] = [];
	for (const row of quotas) {
		if (row.resetsAt === null) continue;
		const resetMs = row.resetsAt * 1000;
		if (resetMs <= now) continue;
		const subject = subjectOf(row, (perProvider.get(row.provider) ?? 0) > 1);
		const at = `${formatClock(new Date(resetMs).toISOString())} (in ${formatWaitMs(resetMs - now)})`;
		const notice = noticeOf(row, subject, at);
		if (notice !== null) notices.push(notice);
	}
	return notices;
}

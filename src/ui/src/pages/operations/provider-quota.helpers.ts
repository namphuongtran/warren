import type { ProviderQuotaView } from "@/api/ops-types.ts";
// Relative, not `@/`: the repo-root `bun test` resolves no `@/` alias for
// value imports (mx-2e4a1a rule).
import { formatWaitMs } from "../../lib/format-wait.ts";

/**
 * The provider usage notices on the Operations page (namphuongtran/warren#30),
 * from `GET /provider-quota`. Pure, so the copy is testable without a DOM.
 *
 * A spent window (`exhausted`) is a warning: Warren holds scheduled runs and
 * refuses manual dispatches on that credential until the reset. A window the
 * provider flags as nearly used (`allowed_warning`) is information. Every
 * other report says nothing, and so does a report whose reset has passed:
 * the window reopened even if no new report arrived.
 */

export interface ProviderQuotaNotice {
	readonly key: string;
	readonly variant: "warning" | "info";
	readonly title: string;
	readonly detail: string;
}

const NEARLY_SPENT = "allowed_warning";

/** "five-hour" from `five_hour`; "usage" when the provider named no window. */
function windowLabel(rateLimitType: string | null): string {
	return rateLimitType === null ? "usage" : rateLimitType.replaceAll("_", "-");
}

function subjectOf(row: ProviderQuotaView, named: boolean): string {
	const credential = named ? ` (credential ${row.credentialFingerprint.slice(0, 6)})` : "";
	return `The ${row.provider} ${windowLabel(row.rateLimitType)} window${credential}`;
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
		const key = `${row.provider}:${row.credentialFingerprint}`;
		if (row.exhausted) {
			notices.push({
				key,
				variant: "warning",
				title: "Provider usage limit reached",
				detail:
					`${subject} reopens at ${at}. ` +
					"Scheduled runs wait and start after the reset, and stopped runs resume. " +
					"A manual dispatch is refused unless you hold it or force it.",
			});
		} else if (row.status === NEARLY_SPENT) {
			const used =
				row.utilization === null ? "nearly used" : `${Math.round(row.utilization * 100)}% used`;
			notices.push({
				key,
				variant: "info",
				title: "Provider usage nearly spent",
				detail: `${subject} is ${used}. It resets at ${at}.`,
			});
		}
	}
	return notices;
}

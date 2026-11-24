import { useQuery } from "@tanstack/react-query";
import { opsApi } from "@/api/client.ts";
import { Alert } from "@/components/ui/alert.tsx";
import { formatError } from "@/lib/format-error.ts";
import { formatTimestamp } from "@/lib/utils.ts";
import { providerQuotaNotices } from "./provider-quota.helpers.ts";

/**
 * Provider usage notices for the Operations page (namphuongtran/warren#30):
 * one alert per credential whose usage window is spent or nearly spent, from
 * `GET /provider-quota`. Mount it inside `OperatorOnly`, because spectators
 * are not served the route. While it loads, and when every window is open,
 * it renders nothing. A failed read shows one neutral line.
 */
export function ProviderQuotaAlert({ now }: { now: number }) {
	const quota = useQuery({
		queryKey: ["provider-quota"],
		queryFn: ({ signal }) => opsApi.providerQuota(signal),
		refetchInterval: 60_000,
	});
	if (quota.isError) {
		return (
			<Alert variant="neutral">Provider usage is unavailable: {formatError(quota.error)}</Alert>
		);
	}
	const notices = providerQuotaNotices(quota.data?.quotas ?? [], now, formatTimestamp);
	if (notices.length === 0) return null;
	return (
		<div className="flex flex-col gap-2">
			{notices.map((notice) => (
				<Alert key={notice.key} variant={notice.variant} title={notice.title}>
					{notice.detail}
				</Alert>
			))}
		</div>
	);
}

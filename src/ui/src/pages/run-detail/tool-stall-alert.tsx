import type { RunToolStallView } from "@/api/types.ts";
import { Alert } from "@/components/ui/alert.tsx";
import { toolStallSummary } from "@/pages/run-detail-format.ts";

/**
 * The run page's stalled-call warning (namphuongtran/warren#83): the run is
 * running, but one tool call has stayed open past the watchdog's stall
 * threshold. A warning, not a verdict, since a long gate can be legitimate. When
 * the project sets a kill threshold, the watchdog fails the run past it.
 * The page refetches the run every few seconds, so `Date.now()` stays fresh
 * and the alert clears once the call returns.
 */
export function ToolStallAlert({ stall }: { stall: RunToolStallView | null | undefined }) {
	if (stall === null || stall === undefined) return null;
	return (
		<Alert variant="warning" title="Tool call stalled">
			<p>
				{toolStallSummary(stall, Date.now())} A long gate can be legitimate. Cancel the run if the
				call is hung.
			</p>
			{stall.command !== null ? (
				<code className="mt-1 block break-all font-mono text-xs">{stall.command}</code>
			) : null}
		</Alert>
	);
}

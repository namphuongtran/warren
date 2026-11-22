import { useEffect, useRef } from "react";
import type { RunEvent } from "@/api/types.ts";

/**
 * Event kinds whose arrival means the warren run row may have advanced
 * (state transition, cancel forwarded, reap finalized, preview flips).
 */
const REFETCH_TRIGGER_KINDS: ReadonlySet<string> = new Set([
	"state_change",
	"cancel.requested",
	"reap.completed",
	"reap_failed",
	"preview_launched",
	"preview_evicted",
	"preview_torn_down",
]);

/**
 * Invalidate the ["runs"] query family when an event with a
 * state-changing kind arrives. Tracked via index, not seq, so events
 * appended out of observed order would still be considered.
 */
export function useRefetchOnTriggerEvents(events: RunEvent[], qc: QueryClientLike) {
	const processedEventCountRef = useRef(0);
	useEffect(() => {
		const len = events.length;
		if (len <= processedEventCountRef.current) {
			processedEventCountRef.current = len;
			return;
		}
		let trigger = false;
		for (let i = processedEventCountRef.current; i < len; i++) {
			const evt = events[i];
			if (evt !== undefined && REFETCH_TRIGGER_KINDS.has(evt.kind)) {
				trigger = true;
				break;
			}
		}
		processedEventCountRef.current = len;
		if (trigger) {
			void qc.invalidateQueries({ queryKey: ["runs"] });
		}
	}, [events, qc]);
}

interface QueryClientLike {
	invalidateQueries: (opts: { queryKey: string[] }) => Promise<unknown>;
}

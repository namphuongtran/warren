/**
 * "25m" / "1h 05m": a wait in whole minutes, rounded up so a wait still in
 * progress never reads as 0m. Used for provider quota resets
 * (namphuongtran/warren#30).
 */
export function formatWaitMs(ms: number): string {
	const minutes = Math.max(1, Math.ceil(ms / 60_000));
	if (minutes < 60) return `${minutes}m`;
	return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

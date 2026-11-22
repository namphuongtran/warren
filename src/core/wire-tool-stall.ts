/**
 * Stalled tool call vocabulary (namphuongtran/warren#83). Re-exported by
 * `src/core/wire.ts` so the canonical import path stays `src/core/wire.ts`.
 */

/**
 * A running run's tool call that the watchdog warned about and that is still
 * open. An operator-only overlay (`toolStall`) on `GET /runs` and
 * `GET /runs/:id`: `null` while the run is not stalled.
 */
export interface RunToolStallView {
	readonly toolUseId: string;
	/** The harness's tool name (`Bash`), when the harness reported one. */
	readonly toolName: string | null;
	/** The call's command, cut to 200 characters, when it has one. */
	readonly command: string | null;
	/** ISO8601 time the call opened. */
	readonly openedAt: string;
	/** ISO8601 time the watchdog wrote its `watchdog.tool_stalled` warning. */
	readonly warnedAt: string;
}

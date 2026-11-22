/**
 * Workspace snapshots host-side finalize takes before `terminate` destroys
 * the workspace, chiefly the agent-written run notes: the handoff report
 * (namphuongtran/warren#21) and the approach note (namphuongtran/warren#33).
 * Each note is clipped past its cap before it leaves finalize; reap validates
 * and stores it.
 */

import { join } from "node:path";
import {
	clipRunApproachBody,
	clipRunHandoffBody,
	RUN_APPROACH_PATH,
	RUN_HANDOFF_PATH,
} from "../../core/wire.ts";
import type { ReapFs } from "../../runs/reap/types.ts";
import type { FinalizeResult } from "../contract.ts";

export type RunNoteBodies = Required<Pick<FinalizeResult, "handoffBody" | "approachBody">>;

/** Snapshot a workspace file before `terminate` destroys it; `null` if absent/unreadable. */
export async function captureWorkspaceFile(
	workspacePath: string,
	relPath: string,
	fs: ReapFs,
): Promise<string | null> {
	try {
		return await fs.readFile(join(workspacePath, relPath));
	} catch {
		return null;
	}
}

/** Read both notes off the workspace; `null` for one that is absent or unreadable. */
export async function captureRunNotes(workspacePath: string, fs: ReapFs): Promise<RunNoteBodies> {
	const handoff = await captureWorkspaceFile(workspacePath, RUN_HANDOFF_PATH, fs);
	const approach = await captureWorkspaceFile(workspacePath, RUN_APPROACH_PATH, fs);
	return {
		handoffBody: handoff === null ? null : clipRunHandoffBody(handoff),
		approachBody: approach === null ? null : clipRunApproachBody(approach),
	};
}

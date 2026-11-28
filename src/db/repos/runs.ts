/** Repository for the `runs` table (queued → running → terminal). */

import { and, eq } from "drizzle-orm";
import { NotFoundError, StateTransitionError, ValidationError } from "../../core/errors.ts";
import { generateId } from "../../core/ids.ts";
import type { SqliteDrizzleDb } from "../client.ts";
import type {
	CloneKind,
	PullRequestLifecycle,
	RunApproachRecord,
	RunCostBasis,
	RunFailureReason,
	RunHandoffRecord,
	RunMode,
	RunPrChecks,
	RunQualityFlags,
	RunQualityGateOutcome,
	RunRow,
	RunState,
	RunTerminalState,
} from "../schema.ts";
import type { DrizzleAdapter } from "./drizzle-adapter.ts";
import { fixAttemptHistoryByPrUrl, listPrCandidatesByProject } from "./runs-ci-fixer.ts";
import { deleteNeverStarted } from "./runs-delete.ts";
import {
	type RunOutcomeFacts,
	setApproach as setApproachBody,
	setHandoff as setHandoffBody,
	setOutcomeFacts as setOutcomeFactsBody,
	setQualityFlags as setQualityFlagsBody,
	setQualityGateOutcome as setQualityGateOutcomeBody,
} from "./runs-outcome-facts.ts";
import { setBranch, setModel, setPrChecks, setPrState, setPrUrl } from "./runs-pr.ts";
import { type AttachPreviewInput, attachPreview } from "./runs-preview.ts";
import {
	aggregate,
	findByRetryOf,
	listAll,
	listByAgent,
	listByIds,
	listByProject,
	listByState,
	listFailedSince,
	listForAnalytics,
	listOperatorContinuationsOf,
	listWithUnresolvedPr,
	type RunContinuationLink,
} from "./runs-queries.ts";
import { markAgentEnded, markReaped, markWorkspaceReady } from "./runs-stage.ts";
import { countNonTerminal, countNonTerminalAutomatic } from "./runs-stats.ts";
import { clearBurrowIdForWorkspace } from "./runs-workspace.ts";

const ALLOWED_TRANSITIONS: Record<RunState, readonly RunState[]> = {
	queued: ["running", "cancelled"],
	running: ["succeeded", "failed", "cancelled"],
	succeeded: [],
	failed: [],
	cancelled: [],
};

export function assertRunTransition(from: RunState, to: RunState): void {
	if (!ALLOWED_TRANSITIONS[from].includes(to)) {
		throw new StateTransitionError(`invalid run transition: ${from} → ${to}`);
	}
}

// Preview-transition guard + input shape live in runs-preview.ts (file-size split).
export { type AttachPreviewInput, assertPreviewTransition } from "./runs-preview.ts";

export interface CreateRunInput {
	id?: string;
	agentName: string;
	projectId: string;
	prompt: string;
	renderedAgentJson: unknown;
	trigger: string;
	sandboxId?: string | null;
	sandboxRunId?: string | null;
	/** Worker hosting the burrow (warren-135b); denormalized for run routing. */
	workerId?: string | null;
	/** Seeds issue back-link (pl-bb70 step 3); null = no seed. */
	seedId?: string | null;
	/** Run mode (pl-0344 / warren-67b6): `batch` (default) or `interactive`; fixed at create. */
	mode?: RunMode;
	/** Continuation/replicate back-link (warren-4b11 / warren-e96f); null for root runs. */
	parentRunId?: string | null;
	/** Infra-lost auto-retry back-link (warren-4af7); null for first attempts. */
	retryOf?: string | null;
	cloneKind?: CloneKind | null; // chain kind (warren-e96f); null for root runs
	/** Operator-requested target branch (warren-1f81, #419); null = none. */
	targetBranch?: string | null;
	/** Dispatch-supplied git ref the workspace clones from (warren-afeb); null = none. */
	ref?: string | null;
	/** Base-commit pin (warren-aaf7): 40-hex SHA the workspace is cut at; null = none. */
	baseCommit?: string | null;
	provider?: string | null; // declared provider/model frozen at dispatch (warren-2ede)
	model?: string | null;
	qualityGate?: string | null; // frozen at dispatch (namphuongtran/warren#36); null = unconfigured
	protectedPaths?: string[] | null; // frozen at dispatch (namphuongtran/warren#37); null = default
	costBasis?: RunCostBasis; // cost basis (warren-f3c3); defaults to `api`
	now?: Date; // queued-instant override (warren-0af9); defaults to the wall clock
}

/** Paging and sort for the run list reads. */
type RunListOptions = {
	limit?: number;
	offset?: number;
	sort?: "started" | "cost";
	dir?: "asc" | "desc";
};

export interface AttachBurrowInput {
	sandboxId?: string;
	sandboxRunId?: string;
	workerId?: string;
}

export interface AttachStatsInput {
	costUsd?: number | null;
	tokensInput?: number | null;
	tokensOutput?: number | null;
	tokensCacheRead?: number | null;
	tokensCacheWrite?: number | null;
}

export class RunsRepo {
	constructor(private readonly adapter: DrizzleAdapter) {}

	private get db(): SqliteDrizzleDb {
		return this.adapter.drizzle as SqliteDrizzleDb;
	}

	private get runs() {
		return this.adapter.schema.runs;
	}

	async create(input: CreateRunInput): Promise<RunRow> {
		const { costBasis = "api", qualityGate = null, protectedPaths = null } = input;
		const row: RunRow = {
			id: input.id ?? generateId("run"),
			agentName: input.agentName,
			projectId: input.projectId,
			sandboxId: input.sandboxId ?? null,
			sandboxRunId: input.sandboxRunId ?? null,
			workerId: input.workerId ?? null,
			seedId: input.seedId ?? null,
			parentRunId: input.parentRunId ?? null,
			cloneKind: input.cloneKind ?? null,
			retryOf: input.retryOf ?? null,
			renderedAgentJson: input.renderedAgentJson,
			state: "queued",
			failureReason: null,
			createdAt: (input.now ?? new Date()).getTime(), // queued instant (warren-0af9)
			startedAt: null,
			endedAt: null,
			// Stage timestamps (warren-7116); every edge stamps post-insert.
			workspaceReadyAt: null,
			agentReadyAt: null,
			agentEndedAt: null,
			reapedAt: null,
			prompt: input.prompt,
			trigger: input.trigger,
			prUrl: null,
			targetBranch: input.targetBranch ?? null,
			branch: null,
			ref: input.ref ?? null,
			baseCommit: input.baseCommit ?? null,
			provider: input.provider ?? null,
			model: input.model ?? null,
			// Merge-watcher facts (warren-3bc6): unset until post_reap settles the PR.
			prState: null,
			prMergedAt: null,
			prChecks: null,
			// Outcome facts (warren-ab2b): unknown until reap measures them — NULL.
			commitsAhead: null,
			baseSha: null,
			filesChanged: null,
			insertions: null,
			deletions: null,
			qualityGate,
			qualityGateOutcome: null,
			protectedPaths,
			qualityFlags: null,
			handoff: null,
			approach: null,
			salvageRef: null,
			salvagePath: null,
			costUsd: null,
			costBasis,
			tokensInput: null,
			tokensOutput: null,
			tokensCacheRead: null,
			tokensCacheWrite: null,
			previewState: null,
			previewPort: null,
			previewStartedAt: null,
			previewLastHitAt: null,
			previewFailureMessage: null,
			mode: input.mode ?? "batch",
		};
		await this.adapter.runWrite(this.db.insert(this.runs).values(row));
		return row;
	}

	async get(id: string): Promise<RunRow | null> {
		const row = await this.adapter.pickOne(
			this.db.select().from(this.runs).where(eq(this.runs.id, id)),
		);
		return row ?? null;
	}

	async require(id: string): Promise<RunRow> {
		const row = await this.get(id);
		if (!row) throw new NotFoundError(`run not found: ${id}`);
		return row;
	}

	/** Hard-delete a never-started run row (warren-a0a2); body in runs-delete.ts. */
	deleteNeverStarted(id: string): Promise<boolean> {
		return deleteNeverStarted(this.adapter, id);
	}

	/** Read/query methods (warren-ac7f); bodies live in runs-queries.ts. */
	listAll(options: RunListOptions = {}): Promise<RunRow[]> {
		return listAll(this.adapter, options);
	}

	listByProject(projectId: string, options: RunListOptions = {}): Promise<RunRow[]> {
		return listByProject(this.adapter, projectId, options);
	}

	listByAgent(agentName: string, options: RunListOptions = {}): Promise<RunRow[]> {
		return listByAgent(this.adapter, agentName, options);
	}

	aggregate(filter: { projectId?: string; agentName?: string } = {}): Promise<{
		total: number;
		costTotalUsd: number;
		costPricedCount: number;
	}> {
		return aggregate(this.adapter, filter);
	}

	listForAnalytics(
		filter: { projectId?: string; from?: string; to?: string } = {},
	): Promise<RunRow[]> {
		return listForAnalytics(this.adapter, filter);
	}

	listByIds(ids: readonly string[]): Promise<RunRow[]> {
		return listByIds(this.adapter, ids);
	}

	listByState(state: RunState | RunState[]): Promise<RunRow[]> {
		return listByState(this.adapter, state);
	}

	/** Non-terminal (`queued`+`running`) count; body in runs-stats.ts (warren-e1f1). */
	countNonTerminal(projectId?: string): Promise<number> {
		return countNonTerminal(this.adapter, projectId);
	}

	/** Non-terminal runs from automatic triggers only. */
	countNonTerminalAutomatic(): Promise<number> {
		return countNonTerminalAutomatic(this.adapter);
	}

	/** Failed runs with `failureReason` that ended since an ISO instant (namphuongtran/warren#30). */
	listFailedSince(failureReason: RunFailureReason, endedSince: string): Promise<RunRow[]> {
		return listFailedSince(this.adapter, failureReason, endedSince);
	}

	/** Operator-dispatched continuations of these runs, newest first (namphuongtran/warren#25). */
	listOperatorContinuationsOf(parentIds: readonly string[]): Promise<RunContinuationLink[]> {
		return listOperatorContinuationsOf(this.adapter, parentIds);
	}

	/** The retry a `sandbox_run_lost` original spawned (warren-4af7); body in runs-queries.ts. */
	findByRetryOf(runId: string): Promise<RunRow | null> {
		return findByRetryOf(this.adapter, runId);
	}

	/** Write back sandbox IDs as spawn provisions them; at least one field required. */
	async attachBurrow(id: string, input: AttachBurrowInput): Promise<RunRow> {
		if (
			input.sandboxId === undefined &&
			input.sandboxRunId === undefined &&
			input.workerId === undefined
		) {
			throw new ValidationError(
				"attachBurrow requires at least one of sandboxId, sandboxRunId, or workerId",
			);
		}
		const current = await this.require(id);
		const patch: { sandboxId?: string; sandboxRunId?: string; workerId?: string } = {};
		if (input.sandboxId !== undefined) patch.sandboxId = input.sandboxId;
		if (input.sandboxRunId !== undefined) patch.sandboxRunId = input.sandboxRunId;
		if (input.workerId !== undefined) patch.workerId = input.workerId;
		await this.adapter.runWrite(this.db.update(this.runs).set(patch).where(eq(this.runs.id, id)));
		return { ...current, ...patch };
	}

	/** Null sandboxId after workspace destroy (warren-9b77); body in runs-workspace.ts. */
	clearBurrowIdForWorkspace(sandboxId: string): Promise<void> {
		return clearBurrowIdForWorkspace(this.adapter, sandboxId);
	}

	/** Stage-timestamp writers (warren-7116); bodies live in runs-stage.ts. */
	markWorkspaceReady(id: string, at: Date = new Date()): Promise<void> {
		return markWorkspaceReady(this.adapter, id, at);
	}

	markAgentEnded(id: string, at: Date = new Date()): Promise<void> {
		return markAgentEnded(this.adapter, id, at);
	}

	markReaped(id: string, at: Date = new Date()): Promise<void> {
		return markReaped(this.adapter, id, at);
	}

	async markRunning(id: string, now: Date = new Date()): Promise<RunRow> {
		const current = await this.require(id);
		assertRunTransition(current.state, "running");
		const patch = {
			state: "running" as const,
			startedAt: now.toISOString(),
		};
		await this.adapter.runWrite(this.db.update(this.runs).set(patch).where(eq(this.runs.id, id)));
		return { ...current, ...patch };
	}

	async finalize(
		id: string,
		terminal: RunTerminalState,
		now: Date = new Date(),
		failureReason: RunFailureReason | null = null,
	): Promise<RunRow> {
		const current = await this.require(id);
		assertRunTransition(current.state, terminal);
		const patch = {
			state: terminal,
			endedAt: now.toISOString(),
			failureReason: terminal === "failed" ? failureReason : null,
		};
		await this.adapter.runWrite(this.db.update(this.runs).set(patch).where(eq(this.runs.id, id)));
		return { ...current, ...patch };
	}

	/**
	 * Persist per-run cost + token accounting (warren-a7dc) as a partial patch: an
	 * omitted field keeps its value and explicit `null` clears it, so the bridge can land
	 * start and end snapshots on different turns. Throws ValidationError when no field was
	 * supplied (like `attachBurrow`). Runs without stats (non-pi, failed RPC) stay null.
	 */
	async attachStats(id: string, input: AttachStatsInput): Promise<RunRow> {
		const keys: (keyof AttachStatsInput)[] = [
			"costUsd",
			"tokensInput",
			"tokensOutput",
			"tokensCacheRead",
			"tokensCacheWrite",
		];
		if (keys.every((k) => input[k] === undefined)) {
			throw new ValidationError("attachStats requires at least one stat field");
		}
		const current = await this.require(id);
		const patch: Partial<RunRow> = {};
		for (const k of keys) {
			if (input[k] !== undefined) {
				(patch as Record<string, number | null>)[k] = input[k] as number | null;
			}
		}
		await this.adapter.runWrite(this.db.update(this.runs).set(patch).where(eq(this.runs.id, id)));
		return { ...current, ...patch };
	}

	/**
	 * Narrow write-through for the usage hydrator (warren-b33e): persist
	 * derived cost/token totals onto the run row wholesale (no partial
	 * patch semantics — the caller always has a full aggregate). Leaves
	 * `cost_basis` and every other column untouched.
	 */
	async updateUsage(
		id: string,
		stats: {
			costUsd: number;
			tokensInput: number;
			tokensOutput: number;
			tokensCacheRead: number;
			tokensCacheWrite: number;
		},
	): Promise<void> {
		await this.adapter.runWrite(this.db.update(this.runs).set(stats).where(eq(this.runs.id, id)));
	}

	/** Preview-environment write (R-19); body lives in runs-preview.ts. */
	attachPreview(id: string, input: AttachPreviewInput): Promise<RunRow> {
		return attachPreview(this.adapter, id, input);
	}

	/** PR, branch, model, and check-summary fact writes; bodies live in runs-pr.ts. */
	setPrUrl(id: string, prUrl: string | null): Promise<RunRow> {
		return setPrUrl(this.adapter, id, prUrl);
	}

	setBranch(id: string, branch: string): Promise<RunRow> {
		return setBranch(this.adapter, id, branch);
	}

	setModel(id: string, model: string): Promise<void> {
		return setModel(this.adapter, id, model);
	}

	setPrState(id: string, prState: PullRequestLifecycle, prMergedAt: string | null) {
		return setPrState(this.adapter, id, prState, prMergedAt);
	}

	setPrChecks(id: string, checks: RunPrChecks): Promise<void> {
		return setPrChecks(this.adapter, id, checks);
	}

	/** PRs the merge watcher still has to settle (warren-3bc6): boot re-adopts these. */
	listWithUnresolvedPr(): Promise<RunRow[]> {
		return listWithUnresolvedPr(this.adapter);
	}

	/** Where a failed finalize's work was salvaged (warren-cd3b): rescue ref and/or
	 * git bundle. Last write wins. */
	async setSalvage(
		id: string,
		salvage: { rescueRef: string | null; bundlePath: string | null },
	): Promise<RunRow> {
		const current = await this.require(id);
		await this.adapter.runWrite(
			this.db
				.update(this.runs)
				.set({ salvageRef: salvage.rescueRef, salvagePath: salvage.bundlePath })
				.where(eq(this.runs.id, id)),
		);
		return { ...current, salvageRef: salvage.rescueRef, salvagePath: salvage.bundlePath };
	}

	/** Reap-time outcome facts (warren-ab2b); NULL = unknown. Body in runs-outcome-facts.ts. */
	async setOutcomeFacts(id: string, facts: RunOutcomeFacts): Promise<RunRow> {
		return setOutcomeFactsBody(this.adapter, id, facts);
	}

	/**
	 * Reap-recorded facts, bodies in runs-outcome-facts.ts: the gate outcome
	 * (namphuongtran/warren#36), the handoff report (#21), the approach note
	 * (#33), and the shortcut flags (#37).
	 */
	async setQualityGateOutcome(id: string, outcome: RunQualityGateOutcome): Promise<void> {
		await setQualityGateOutcomeBody(this.adapter, id, outcome);
	}

	async setHandoff(id: string, record: RunHandoffRecord): Promise<void> {
		await setHandoffBody(this.adapter, id, record);
	}

	async setApproach(id: string, record: RunApproachRecord): Promise<void> {
		await setApproachBody(this.adapter, id, record);
	}

	async setQualityFlags(id: string, flags: RunQualityFlags): Promise<void> {
		await setQualityFlagsBody(this.adapter, id, flags);
	}

	/** CI-fixer queries (warren-0b75); bodies live in runs-ci-fixer.ts. */
	listPrCandidatesByProject(projectId: string, limit = 25) {
		return listPrCandidatesByProject(this.adapter, projectId, limit);
	}

	fixAttemptHistoryByPrUrl(prUrl: string) {
		return fixAttemptHistoryByPrUrl(this.adapter, prUrl);
	}

	/** Atomic queued → running ("the run loop picked this up"); null if gone or not queued. */
	async claimById(id: string, now: Date = new Date()): Promise<RunRow | null> {
		return this.adapter.runInTransaction(async (tx) => {
			const txDb = tx.drizzle as SqliteDrizzleDb;
			const runs = tx.schema.runs;
			const row = await tx.pickOne(txDb.select().from(runs).where(eq(runs.id, id)));
			if (row?.state !== "queued") return null;
			const startedAt = now.toISOString();
			await tx.runWrite(
				txDb
					.update(runs)
					.set({ state: "running", startedAt, agentReadyAt: startedAt })
					.where(and(eq(runs.id, id), eq(runs.state, "queued"))),
			);
			return { ...row, state: "running", startedAt, agentReadyAt: startedAt };
		});
	}
}

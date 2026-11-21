/**
 * Cross-model review rounds (namphuongtran/warren#18).
 *
 * One live row per (work item, PR head SHA): the reviewer run dispatched
 * for that exact commit and the verdict it returned. The partial unique
 * index is what binds a verdict to a SHA — a new push is a new row, and a
 * row whose SHA is no longer the head is superseded rather than published.
 * Superseded rows leave the index, so a head that returns to an old SHA
 * gets a fresh review.
 */
import type { SQLQueryBindings } from "bun:sqlite";
import { StateError } from "../errors.ts";
import { nowMs, type StoreContext } from "./context.ts";
import type { ReviewRoundRow, ReviewRoundState } from "./types.ts";

type ReviewRoundDbRow = {
	id: string;
	campaign_id: string;
	work_item_id: string;
	pr_number: number;
	head_sha: string;
	round: number;
	action_id: string | null;
	run_id: string | null;
	state: string;
	verdict_json: string | null;
	failure_reason: string | null;
	created_at_ms: number;
	updated_at_ms: number;
};

function toRound(row: ReviewRoundDbRow): ReviewRoundRow {
	return {
		id: row.id,
		campaignId: row.campaign_id,
		workItemId: row.work_item_id,
		prNumber: row.pr_number,
		headSha: row.head_sha,
		round: row.round,
		actionId: row.action_id,
		runId: row.run_id,
		state: row.state as ReviewRoundState,
		verdictJson: row.verdict_json,
		failureReason: row.failure_reason,
		createdAtMs: row.created_at_ms,
		updatedAtMs: row.updated_at_ms,
	};
}

export class ReviewStore {
	readonly #ctx: StoreContext;

	constructor(ctx: StoreContext) {
		this.#ctx = ctx;
	}

	getRound(id: string): ReviewRoundRow | null {
		const row = this.#ctx.db
			.query("SELECT * FROM review_rounds WHERE id = ?")
			.get(id) as ReviewRoundDbRow | null;
		return row === null ? null : toRound(row);
	}

	/** The live (not superseded) round for a head SHA, if any. */
	getByHead(workItemId: string, headSha: string): ReviewRoundRow | null {
		const row = this.#ctx.db
			.query(
				"SELECT * FROM review_rounds WHERE work_item_id = ? AND head_sha = ? AND state != 'superseded'",
			)
			.get(workItemId, headSha) as ReviewRoundDbRow | null;
		return row === null ? null : toRound(row);
	}

	/** Every round of the work item, oldest first. */
	listForWorkItem(workItemId: string): ReviewRoundRow[] {
		const rows = this.#ctx.db
			.query("SELECT * FROM review_rounds WHERE work_item_id = ? ORDER BY round, id")
			.all(workItemId) as ReviewRoundDbRow[];
		return rows.map(toRound);
	}

	/** Open a round for a head SHA. Refuses a second live round for the same SHA. */
	insertDispatched(input: {
		campaignId: string;
		workItemId: string;
		prNumber: number;
		headSha: string;
	}): ReviewRoundRow {
		if (this.getByHead(input.workItemId, input.headSha) !== null) {
			throw new StateError(
				`work item ${input.workItemId} already has a review round for ${input.headSha}`,
			);
		}
		const round = this.listForWorkItem(input.workItemId).length + 1;
		const id = this.#ctx.ids.newId();
		const now = nowMs(this.#ctx);
		this.#ctx.db
			.query(
				`INSERT INTO review_rounds (id, campaign_id, work_item_id, pr_number, head_sha, round,
				 action_id, run_id, state, verdict_json, failure_reason, created_at_ms, updated_at_ms)
				 VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, 'dispatched', NULL, NULL, ?, ?)`,
			)
			.run(id, input.campaignId, input.workItemId, input.prNumber, input.headSha, round, now, now);
		return this.getRound(id) as ReviewRoundRow;
	}

	/** Link the journaled `review_run` action to its round. */
	recordActionId(id: string, actionId: string): void {
		this.#update(id, { action_id: actionId });
	}

	recordRunId(id: string, runId: string): void {
		this.#update(id, { run_id: runId });
	}

	/** Settle a live round. A settled round never changes again. */
	settle(
		id: string,
		input: {
			state: Exclude<ReviewRoundState, "dispatched">;
			verdictJson?: string;
			failureReason?: string;
		},
	): ReviewRoundRow {
		const round = this.getRound(id);
		if (round === null) {
			throw new StateError(`no review round ${id}`);
		}
		if (round.state !== "dispatched") {
			throw new StateError(`review round ${id} is already ${round.state}`);
		}
		this.#update(id, {
			state: input.state,
			verdict_json: input.verdictJson ?? null,
			failure_reason: input.failureReason ?? null,
		});
		return this.getRound(id) as ReviewRoundRow;
	}

	#update(id: string, patch: Record<string, SQLQueryBindings>): void {
		const entries = Object.entries(patch);
		const sets = entries.map(([key]) => `${key} = ?`).join(", ");
		const result = this.#ctx.db
			.query(`UPDATE review_rounds SET ${sets}, updated_at_ms = ? WHERE id = ?`)
			.run(...entries.map(([, value]) => value), nowMs(this.#ctx), id);
		if (result.changes === 0) {
			throw new StateError(`no review round ${id}`);
		}
	}
}

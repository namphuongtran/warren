/**
 * Cross-model review rounds and their panel seats (namphuongtran/warren#18).
 *
 * One live round per (work item, PR head SHA): the review of that exact
 * commit and the verdict the panel decided. The partial unique index is
 * what binds a verdict to a SHA — a new push is a new round, and a round
 * whose SHA is no longer the head is superseded rather than published.
 * Superseded rounds leave the index, so a head that returns to an old SHA
 * gets a fresh review.
 *
 * Each round holds one seat per panel reviewer (Phase 2): the run that
 * reviewer was dispatched as and the verdict it returned. A seat settles on
 * its own; the round settles once every seat has.
 */
import type { SQLQueryBindings } from "bun:sqlite";
import { StateError } from "../errors.ts";
import { nowMs, type StoreContext } from "./context.ts";
import type { ReviewRoundRow, ReviewRoundState, ReviewSeatRow, ReviewSeatState } from "./types.ts";

type ReviewRoundDbRow = {
	id: string;
	campaign_id: string;
	work_item_id: string;
	pr_number: number;
	head_sha: string;
	round: number;
	state: string;
	verdict_json: string | null;
	failure_reason: string | null;
	created_at_ms: number;
	updated_at_ms: number;
};

type ReviewSeatDbRow = {
	id: string;
	round_id: string;
	seat: number;
	agent: string | null;
	provider: string | null;
	model: string | null;
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
		state: row.state as ReviewRoundState,
		verdictJson: row.verdict_json,
		failureReason: row.failure_reason,
		createdAtMs: row.created_at_ms,
		updatedAtMs: row.updated_at_ms,
	};
}

function toSeat(row: ReviewSeatDbRow): ReviewSeatRow {
	return {
		id: row.id,
		roundId: row.round_id,
		seat: row.seat,
		agent: row.agent,
		provider: row.provider,
		model: row.model,
		actionId: row.action_id,
		runId: row.run_id,
		state: row.state as ReviewSeatState,
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
		this.#update("review_rounds", id, {
			state: input.state,
			verdict_json: input.verdictJson ?? null,
			failure_reason: input.failureReason ?? null,
		});
		return this.getRound(id) as ReviewRoundRow;
	}

	getSeat(id: string): ReviewSeatRow | null {
		const row = this.#ctx.db
			.query("SELECT * FROM review_seats WHERE id = ?")
			.get(id) as ReviewSeatDbRow | null;
		return row === null ? null : toSeat(row);
	}

	/** Every seat of a round, in panel order. */
	listSeats(roundId: string): ReviewSeatRow[] {
		const rows = this.#ctx.db
			.query("SELECT * FROM review_seats WHERE round_id = ? ORDER BY seat")
			.all(roundId) as ReviewSeatDbRow[];
		return rows.map(toSeat);
	}

	/** Open one panel seat of a live round, recording who it dispatches. */
	insertSeat(input: {
		roundId: string;
		seat: number;
		agent: string;
		provider: string | null;
		model: string | null;
	}): ReviewSeatRow {
		const id = this.#ctx.ids.newId();
		const now = nowMs(this.#ctx);
		this.#ctx.db
			.query(
				`INSERT INTO review_seats (id, round_id, seat, agent, provider, model, action_id, run_id,
				 state, verdict_json, failure_reason, created_at_ms, updated_at_ms)
				 VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, 'dispatched', NULL, NULL, ?, ?)`,
			)
			.run(id, input.roundId, input.seat, input.agent, input.provider, input.model, now, now);
		return this.getSeat(id) as ReviewSeatRow;
	}

	/** Link the journaled `review_run` action to its seat. */
	recordSeatActionId(id: string, actionId: string): void {
		this.#update("review_seats", id, { action_id: actionId });
	}

	recordSeatRunId(id: string, runId: string): void {
		this.#update("review_seats", id, { run_id: runId });
	}

	/** Settle a live seat. A settled seat never changes again. */
	settleSeat(
		id: string,
		input: {
			state: Exclude<ReviewSeatState, "dispatched">;
			verdictJson?: string;
			failureReason?: string;
		},
	): ReviewSeatRow {
		const seat = this.getSeat(id);
		if (seat === null) {
			throw new StateError(`no review seat ${id}`);
		}
		if (seat.state !== "dispatched") {
			throw new StateError(`review seat ${id} is already ${seat.state}`);
		}
		this.#update("review_seats", id, {
			state: input.state,
			verdict_json: input.verdictJson ?? null,
			failure_reason: input.failureReason ?? null,
		});
		return this.getSeat(id) as ReviewSeatRow;
	}

	#update(
		table: "review_rounds" | "review_seats",
		id: string,
		patch: Record<string, SQLQueryBindings>,
	): void {
		const entries = Object.entries(patch);
		const sets = entries.map(([key]) => `${key} = ?`).join(", ");
		const result = this.#ctx.db
			.query(`UPDATE ${table} SET ${sets}, updated_at_ms = ? WHERE id = ?`)
			.run(...entries.map(([, value]) => value), nowMs(this.#ctx), id);
		if (result.changes === 0) {
			throw new StateError(
				`no ${table === "review_rounds" ? "review round" : "review seat"} ${id}`,
			);
		}
	}
}

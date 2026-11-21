/**
 * `DurationWatch` — the per-run wall-clock limit at the bridge
 * (namphuongtran/warren#10).
 *
 * The turn monitor (./turn-monitor.ts) measures silence inside an open turn
 * and the watchdog measures silence across the run, so a run that keeps
 * emitting events was never bounded. This watch bounds total elapsed time
 * against the run's `maxDurationMinutes` (resolved by
 * `resolveDurationLimitMs` from the frozen `runs.rendered_agent_json`).
 *
 * Expiry is detected in two places: once when the bridge starts (a resumed
 * run may already be over), then on an interval timer (a silent run parked
 * on the source), and on every event the bridge sees (a busy run). Detection
 * only FLAGS the trip: the timer aborts the parked source, the loop breaks.
 * All I/O happens once, in `settle()`, which the bridge awaits after the loop
 * and before it closes the broker — so the trip never races the loop for
 * `terminalDetected` or for an event seq, and live subscribers see the
 * event. `settle()` follows the `enforceBudgetCap` shape (./budget.ts):
 * persist the observed usage, emit `duration.exceeded`, cancel through the
 * bridge's seam, and return the `failed` / `duration_exceeded` terminal that
 * reap records on the row. A terminal event that lands after expiry still
 * wins: the run finished, so it is not failed for running long.
 */

import type { RunFailureReason, RunTerminalState } from "../../core/wire.ts";
import type { Repos } from "../../db/repos/index.ts";
import { resolveDurationLimitMs } from "../duration-limit.ts";
import type { RunEventBroker } from "../events.ts";
import type { CancelBurrowRunFn } from "./budget.ts";
import { appendSystemEvent } from "./system-event.ts";
import { detectRuntimeTerminal } from "./terminal-detect.ts";
import type { BridgeLogger, StreamEventView } from "./types.ts";

/** Event kind the bridge emits when a run's wall-clock limit elapses. */
export const DURATION_EXCEEDED_EVENT = "duration.exceeded";

/** Timer cadence: one integer compare per tick, so 15s costs nothing. */
export const DEFAULT_DURATION_CHECK_INTERVAL_MS = 15_000;

export interface DurationClock {
	now(): number;
}

const wallClock: DurationClock = { now: () => Date.now() };

export interface DurationTrip {
	readonly elapsedMs: number;
	readonly limitMs: number;
}

export interface DurationWatchOptions {
	/** Wall-clock limit in ms; `null` means unlimited (never trips). */
	readonly limitMs: number | null;
	/** Epoch ms the run started; elapsed time is measured from here. */
	readonly startedAtMs: number;
	readonly clock?: DurationClock;
	readonly checkIntervalMs?: number;
}

export class DurationWatch {
	private readonly limitMs: number | null;
	private readonly startedAtMs: number;
	private readonly clock: DurationClock;
	private readonly checkIntervalMs: number;
	private timer: ReturnType<typeof setInterval> | null = null;

	constructor(options: DurationWatchOptions) {
		this.limitMs = options.limitMs;
		this.startedAtMs = options.startedAtMs;
		this.clock = options.clock ?? wallClock;
		this.checkIntervalMs = options.checkIntervalMs ?? DEFAULT_DURATION_CHECK_INTERVAL_MS;
	}

	/** The trip when elapsed time is strictly past the limit, else `null`. */
	check(): DurationTrip | null {
		if (this.limitMs === null) return null;
		const elapsedMs = this.clock.now() - this.startedAtMs;
		return elapsedMs > this.limitMs ? { elapsedMs, limitMs: this.limitMs } : null;
	}

	/**
	 * Check once now, then arm the interval timer. `onExpired` fires
	 * synchronously and must not do I/O. A no-op for an unlimited run.
	 */
	start(onExpired: (trip: DurationTrip) => void): void {
		if (this.limitMs === null || this.timer !== null) return;
		const tick = (): void => {
			const trip = this.check();
			if (trip === null) return;
			this.stop();
			onExpired(trip);
		};
		this.timer = setInterval(tick, this.checkIntervalMs);
		tick();
	}

	stop(): void {
		if (this.timer !== null) clearInterval(this.timer);
		this.timer = null;
	}
}

/**
 * Build the default watch from the run row: the frozen limit, anchored on
 * `started_at` so a resumed bridge keeps the original clock. A row not yet
 * claimed anchors on now (the bridge starts right after dispatch). A read
 * failure resolves to unlimited so a DB hiccup never blocks streaming.
 */
export async function resolveDurationWatch(
	repos: Repos,
	runId: string,
	logger?: BridgeLogger,
): Promise<DurationWatch> {
	try {
		const run = await repos.runs.require(runId);
		const limitMs = resolveDurationLimitMs(run.renderedAgentJson);
		const startedAtMs = run.startedAt !== null ? Date.parse(run.startedAt) : Number.NaN;
		return new DurationWatch({
			limitMs,
			startedAtMs: Number.isFinite(startedAtMs) ? startedAtMs : Date.now(),
		});
	} catch (err) {
		logger?.warn?.(
			{ runId, err: err instanceof Error ? err.message : String(err) },
			"failed to resolve wall-clock limit; proceeding without enforcement",
		);
		return new DurationWatch({ limitMs: null, startedAtMs: 0 });
	}
}

/** The terminal outcome a wall-clock trip hands to reap. */
export interface DurationTerminal {
	readonly outcome: RunTerminalState;
	readonly failureReason: RunFailureReason;
}

export interface BridgeDurationWatchInput {
	readonly watch: DurationWatch;
	readonly runId: string;
	readonly sandboxRunId: string;
	readonly repos: Repos;
	readonly broker: RunEventBroker;
	readonly cancelBurrowRun: CancelBurrowRunFn;
	/** Persist observed usage; the terminal envelope never arrives once cancelled. */
	readonly persistUsage: () => Promise<void>;
	/** The bridge's abort controller; a timer trip aborts the parked source. */
	readonly ctrl: AbortController;
	readonly logger?: BridgeLogger;
}

export interface BridgeDurationWatch {
	/** True when the loop should stop for this event: the limit passed and it is not terminal. */
	readonly expiredAt: (event: StreamEventView) => boolean;
	/** True once the limit passed (the bridge's catch treats the abort as terminal). */
	readonly tripped: { readonly value: boolean };
	/** Act on a trip once (persist, emit, cancel) and return reap's terminal; else `undefined`. */
	readonly settle: () => Promise<DurationTerminal | undefined>;
	readonly stop: () => void;
}

/** Wire one watch into one bridge run: arms the timer, returns the loop surface. */
export function bridgeDurationWatch(input: BridgeDurationWatchInput): BridgeDurationWatch {
	const tripped = { value: false };
	let pending: DurationTrip | null = null;
	let settled = false;
	const flag = (trip: DurationTrip): void => {
		pending ??= trip;
		tripped.value = true;
	};
	input.watch.start((trip) => {
		flag(trip);
		input.ctrl.abort();
	});
	return {
		expiredAt: (event) => {
			if (detectRuntimeTerminal(event) !== null) return false;
			const trip = pending ?? input.watch.check();
			if (trip === null) return false;
			flag(trip);
			return true;
		},
		tripped,
		settle: async () => {
			if (pending === null) return undefined;
			if (!settled) {
				settled = true;
				await actOnTrip(input, pending);
			}
			return { outcome: "failed", failureReason: "duration_exceeded" };
		},
		stop: () => input.watch.stop(),
	};
}

async function actOnTrip(input: BridgeDurationWatchInput, trip: DurationTrip): Promise<void> {
	input.logger?.warn?.(
		{ runId: input.runId, sandboxRunId: input.sandboxRunId, ...trip },
		"run exceeded wall-clock limit; cancelling",
	);
	await input.persistUsage();
	await appendSystemEvent({
		runId: input.runId,
		kind: DURATION_EXCEEDED_EVENT,
		payload: { elapsedMs: trip.elapsedMs, limitMs: trip.limitMs },
		repos: input.repos,
		broker: input.broker,
		...(input.logger !== undefined ? { logger: input.logger } : {}),
	});
	try {
		await input.cancelBurrowRun(
			`wall-clock limit exceeded: ${trip.elapsedMs}ms > ${trip.limitMs}ms`,
		);
	} catch (err) {
		input.logger?.error?.(
			{
				runId: input.runId,
				sandboxRunId: input.sandboxRunId,
				err: err instanceof Error ? err.message : String(err),
			},
			"wall-clock cancel failed; reap will finalize from terminal-detect",
		);
	}
}

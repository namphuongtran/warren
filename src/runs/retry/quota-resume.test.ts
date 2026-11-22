/**
 * The quota auto-resume (namphuongtran/warren#30 Phase 2), driven through its
 * one seam: `scheduleRun` and `tick` against an in-memory DB with a stubbed
 * `spawnRun`. Assertions read the run's event stream and the spawn input.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { ProviderQuotaExhaustedError, recordQuotaObservation } from "../quota/state.ts";
import {
	appendEvent,
	closeOpenDb,
	createFailedRun,
	kinds,
	lastPayload,
	REAPED_AT,
	RESET_ISO,
	RESETS_AT,
	resumer,
	setup,
	stubSpawn,
} from "./quota-resume.test-fixture.ts";
import { MAX_QUOTA_RESUMES, QUOTA_RESUME_EVENTS } from "./quota-resume.ts";

afterEach(closeOpenDb);

describe("createQuotaResumer", () => {
	test("schedules a quota_exhausted run to resume one minute after the reset", async () => {
		const fixture = await setup();
		const { instance, spawn } = resumer(fixture, { now: REAPED_AT });

		await instance.scheduleRun(fixture.runId);

		expect(await lastPayload(fixture, QUOTA_RESUME_EVENTS.scheduled)).toMatchObject({
			resetsAt: RESETS_AT,
			resumeAt: "2026-11-22T09:11:00.000Z",
			attempt: 1,
			maxAttempts: 3,
		});
		expect(spawn.calls).toHaveLength(0);
	});

	test("dispatches a continue clone at resumeAt and not before", async () => {
		const fixture = await setup({ commitsAhead: 1 });
		const clock = { now: REAPED_AT };
		const { instance, spawn, started } = resumer(fixture, clock);
		await instance.scheduleRun(fixture.runId);

		clock.now = new Date(RESET_ISO);
		await instance.tick();
		expect(spawn.calls).toHaveLength(0);

		clock.now = new Date("2026-11-22T09:11:00.000Z");
		await instance.tick();

		expect(spawn.calls).toHaveLength(1);
		const call = spawn.calls[0];
		expect(call?.parentRunId).toBe(fixture.runId);
		expect(call?.cloneKind).toBe("continue");
		expect(call?.dispatchOrigin).toBe("resume_quota");
		expect(call?.seedId).toBe("warren-30");
		expect(call?.providerOverride).toBe("anthropic");
		expect(call?.modelOverride).toBe("claude-opus-5-5");
		expect(call?.prompt).toContain(fixture.runId);
		expect(call?.prompt).toEndWith("work on sd warren-30");
		const newRunId = (await lastPayload(fixture, QUOTA_RESUME_EVENTS.dispatched)) as {
			newRunId: string;
		};
		expect(started).toEqual([newRunId.newRunId]);
		expect(await lastPayload(fixture, QUOTA_RESUME_EVENTS.spawnResume, newRunId.newRunId)).toEqual({
			resumedFromRunId: fixture.runId,
			attempt: 1,
			mode: "continue",
		});
	});

	test("replicates a run that pushed nothing, with its prompt unchanged", async () => {
		const fixture = await setup({ commitsAhead: 0 });
		const clock = { now: REAPED_AT };
		const { instance, spawn } = resumer(fixture, clock);
		await instance.scheduleRun(fixture.runId);
		clock.now = new Date("2026-11-22T10:00:00.000Z");
		await instance.tick();

		expect(spawn.calls[0]?.cloneKind).toBe("replicate");
		expect(spawn.calls[0]?.prompt).toBe("work on sd warren-30");
	});

	test("dispatches each resume once however often it ticks", async () => {
		const fixture = await setup();
		const clock = { now: REAPED_AT };
		const { instance, spawn } = resumer(fixture, clock);
		await instance.scheduleRun(fixture.runId);
		await instance.scheduleRun(fixture.runId);
		clock.now = new Date("2026-11-22T10:00:00.000Z");
		await instance.tick();
		await instance.tick();

		expect(spawn.calls).toHaveLength(1);
		const ownKinds = await kinds(fixture);
		expect(ownKinds.filter((k) => k === QUOTA_RESUME_EVENTS.scheduled)).toHaveLength(1);
	});

	test("decides a run the post_reap hook never saw", async () => {
		const fixture = await setup();
		const clock = { now: REAPED_AT };
		const { instance, spawn } = resumer(fixture, clock);
		await instance.tick();
		expect(await kinds(fixture)).toContain(QUOTA_RESUME_EVENTS.scheduled);

		clock.now = new Date("2026-11-22T10:00:00.000Z");
		await instance.tick();
		expect(spawn.calls).toHaveLength(1);
	});

	test("waits for the new reset when the window is still closed, keeping the attempt", async () => {
		const fixture = await setup();
		const clock = { now: REAPED_AT };
		const refusal = new ProviderQuotaExhaustedError("spent", {
			reason: "provider_quota_exhausted",
			retryAfterSeconds: 3600,
		});
		const refusing = stubSpawn(fixture.repos, { throw: refusal });
		const { instance } = resumer(fixture, clock, { spawnRunFn: refusing.spawnRunFn });
		await instance.scheduleRun(fixture.runId);
		clock.now = new Date("2026-11-22T09:12:00.000Z");
		await instance.tick();

		expect(refusing.calls).toHaveLength(1);
		expect(await lastPayload(fixture, QUOTA_RESUME_EVENTS.scheduled)).toMatchObject({
			resumeAt: "2026-11-22T10:13:00.000Z",
			attempt: 1,
		});
		await instance.tick();
		expect(refusing.calls).toHaveLength(1);
	});

	test("records a failed dispatch and does not try it again", async () => {
		const fixture = await setup();
		const clock = { now: REAPED_AT };
		const failing = stubSpawn(fixture.repos, { throw: new Error("clone refresh failed") });
		const { instance } = resumer(fixture, clock, { spawnRunFn: failing.spawnRunFn });
		await instance.scheduleRun(fixture.runId);
		clock.now = new Date("2026-11-22T10:00:00.000Z");
		await instance.tick();
		await instance.tick();

		expect(failing.calls).toHaveLength(1);
		expect(await lastPayload(fixture, QUOTA_RESUME_EVENTS.failed)).toEqual({
			error: "clone refresh failed",
		});
	});

	test("fails a resume whose dispatch was interrupted instead of spawning it twice", async () => {
		const fixture = await setup();
		const clock = { now: REAPED_AT };
		const { instance, spawn } = resumer(fixture, clock);
		await instance.scheduleRun(fixture.runId);
		await appendEvent(fixture.repos, fixture.runId, QUOTA_RESUME_EVENTS.started, { attempt: 1 });
		clock.now = new Date("2026-11-22T10:00:00.000Z");
		await instance.tick();

		expect(spawn.calls).toHaveLength(0);
		expect((await kinds(fixture)).at(-1)).toBe(QUOTA_RESUME_EVENTS.failed);
	});

	test("stops a lineage that has spent every resume", async () => {
		const fixture = await setup();
		let resumedFrom = fixture.runId;
		for (let i = 0; i < MAX_QUOTA_RESUMES; i++) {
			const next = await createFailedRun(fixture.repos, fixture.projectId, {
				failureReason: "quota_exhausted",
				trigger: "manual",
				resetsAt: RESETS_AT,
				commitsAhead: null,
			});
			await appendEvent(fixture.repos, next, QUOTA_RESUME_EVENTS.spawnResume, {
				resumedFromRunId: resumedFrom,
			});
			resumedFrom = next;
		}
		const { instance, spawn } = resumer(fixture, { now: REAPED_AT });
		await instance.scheduleRun(resumedFrom);

		expect(await lastPayload(fixture, QUOTA_RESUME_EVENTS.exhausted, resumedFrom)).toEqual({
			attempts: MAX_QUOTA_RESUMES,
			maxAttempts: MAX_QUOTA_RESUMES,
		});
		expect(spawn.calls).toHaveLength(0);
	});

	test("falls back to the credential's stored window when the refusal names no reset", async () => {
		const fixture = await setup({ resetsAt: null });
		await recordQuotaObservation(fixture.repos, {
			credential: { provider: null, env: {} },
			observation: {
				status: "rejected",
				utilization: 1,
				rateLimitType: "five_hour",
				resetsAt: RESETS_AT,
			},
			source: "rate_limit_event",
			sourceRunId: fixture.runId,
			observedAt: REAPED_AT.toISOString(),
		});
		const { instance } = resumer(fixture, { now: REAPED_AT });
		await instance.scheduleRun(fixture.runId);

		expect(await lastPayload(fixture, QUOTA_RESUME_EVENTS.scheduled)).toMatchObject({
			resetsAt: RESETS_AT,
		});
	});

	test("skips a run whose reset is unknown", async () => {
		const fixture = await setup({ resetsAt: null });
		const { instance } = resumer(fixture, { now: REAPED_AT });
		await instance.scheduleRun(fixture.runId);

		expect(await lastPayload(fixture, QUOTA_RESUME_EVENTS.skipped)).toEqual({
			reason: "reset_unknown",
		});
	});

	test("leaves plan-run children to the plan-run coordinator", async () => {
		const fixture = await setup({ trigger: "plan-run" });
		const { instance } = resumer(fixture, { now: REAPED_AT });
		await instance.scheduleRun(fixture.runId);

		expect(await lastPayload(fixture, QUOTA_RESUME_EVENTS.skipped)).toEqual({
			reason: "plan_run_child",
		});
	});

	test("ignores a run that failed for another reason", async () => {
		const fixture = await setup({ failureReason: "crashed" });
		const clock = { now: REAPED_AT };
		const { instance, spawn } = resumer(fixture, clock);
		await instance.scheduleRun(fixture.runId);
		clock.now = new Date("2026-11-22T10:00:00.000Z");
		await instance.tick();

		expect(await kinds(fixture)).toEqual([]);
		expect(spawn.calls).toHaveLength(0);
	});

	test("keeps an automatic run scheduled while the automatic-run cap is full", async () => {
		const fixture = await setup({ trigger: "cron" });
		const busy = await fixture.repos.runs.create({
			agentName: "quota-bot",
			projectId: fixture.projectId,
			prompt: "busy",
			renderedAgentJson: {},
			trigger: "cron",
		});
		const clock = { now: REAPED_AT };
		const { instance, spawn } = resumer(fixture, clock);
		await instance.scheduleRun(fixture.runId);
		clock.now = new Date("2026-11-22T10:00:00.000Z");
		await instance.tick();
		expect(spawn.calls).toHaveLength(0);
		expect((await kinds(fixture)).at(-1)).toBe(QUOTA_RESUME_EVENTS.scheduled);

		await fixture.repos.runs.finalize(busy.id, "cancelled", clock.now);
		await instance.tick();
		expect(spawn.calls).toHaveLength(1);
	});

	test("cuts the resume from a newBranch name instead of recomposing one", async () => {
		const fixture = await setup({ commitsAhead: 2, branch: "feat/quota-work" });
		const clock = { now: REAPED_AT };
		const { instance, spawn } = resumer(fixture, clock);
		await instance.scheduleRun(fixture.runId);
		clock.now = new Date("2026-11-22T10:00:00.000Z");
		await instance.tick();

		expect(spawn.calls[0]).toMatchObject({
			parentRunId: fixture.runId,
			cloneKind: "replicate",
			ref: "feat/quota-work",
		});
	});

	test("dispatches onto the operator's target branch again", async () => {
		const fixture = await setup({
			commitsAhead: 1,
			branch: "fix/pr-head",
			targetBranch: "fix/pr-head",
		});
		const clock = { now: REAPED_AT };
		const { instance, spawn } = resumer(fixture, clock);
		await instance.scheduleRun(fixture.runId);
		clock.now = new Date("2026-11-22T10:00:00.000Z");
		await instance.tick();

		expect(spawn.calls[0]?.targetBranch).toBe("fix/pr-head");
		expect(spawn.calls[0]?.parentRunId).toBeUndefined();
	});

	test("resumes at once when the stored window has already reopened", async () => {
		const fixture = await setup({ resetsAt: null });
		await recordQuotaObservation(fixture.repos, {
			credential: { provider: null, env: {} },
			observation: { status: "allowed", utilization: 0.1, rateLimitType: null, resetsAt: null },
			source: "rate_limit_event",
			sourceRunId: null,
			observedAt: REAPED_AT.toISOString(),
		});
		const { instance } = resumer(fixture, { now: REAPED_AT });
		await instance.scheduleRun(fixture.runId);

		expect(await lastPayload(fixture, QUOTA_RESUME_EVENTS.scheduled)).toMatchObject({
			resumeAt: "2026-11-22T08:51:40.000Z",
		});
	});

	test("treats a non-numeric reset on the refusal as unknown", async () => {
		const fixture = await setup({ resetsAt: "soon" });
		const { instance } = resumer(fixture, { now: REAPED_AT });
		await instance.scheduleRun(fixture.runId);

		expect(await lastPayload(fixture, QUOTA_RESUME_EVENTS.skipped)).toEqual({
			reason: "reset_unknown",
		});
	});

	test("fails a resume whose schedule is unreadable instead of dispatching it", async () => {
		const fixture = await setup();
		await appendEvent(fixture.repos, fixture.runId, QUOTA_RESUME_EVENTS.scheduled, {
			resumeAt: "not a date",
			resetsAt: RESETS_AT,
			attempt: 1,
		});
		const clock = { now: new Date("2026-11-22T10:00:00.000Z") };
		const { instance, spawn } = resumer(fixture, clock);
		await instance.tick();

		expect(spawn.calls).toHaveLength(0);
		expect(await lastPayload(fixture, QUOTA_RESUME_EVENTS.failed)).toEqual({
			error: "the resume schedule is unreadable",
		});
	});

	test("ends the attempt walk on a lineage that loops back on itself", async () => {
		const fixture = await setup();
		const other = await createFailedRun(fixture.repos, fixture.projectId, {
			failureReason: "quota_exhausted",
			trigger: "manual",
			resetsAt: RESETS_AT,
			commitsAhead: null,
		});
		await appendEvent(fixture.repos, fixture.runId, QUOTA_RESUME_EVENTS.spawnResume, {
			resumedFromRunId: other,
		});
		await appendEvent(fixture.repos, other, QUOTA_RESUME_EVENTS.spawnResume, {
			resumedFromRunId: fixture.runId,
		});
		const { instance } = resumer(fixture, { now: REAPED_AT });
		await instance.scheduleRun(fixture.runId);

		expect(await lastPayload(fixture, QUOTA_RESUME_EVENTS.scheduled)).toMatchObject({
			attempt: 3,
		});
	});
});

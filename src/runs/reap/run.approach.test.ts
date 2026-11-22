import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { reapRun } from "./index.ts";
import {
	type Ctx,
	fakeBurrowClient,
	fakeExec,
	fakeForge,
	fakeFs,
	makeBurrow,
	reapDeps,
	setup,
} from "./test-helpers.ts";

/**
 * End-to-end reapRun coverage for the approach note
 * (namphuongtran/warren#33): finalize hands back `.warren/approach.md`, reap
 * stores it on the run, emits the matching event, and the handoff's
 * `approach` block reaches the PR body. The cap and the adherence validator
 * live in `src/core/wire-approach.test.ts` and `src/core/wire-handoff.test.ts`.
 */

const WS = "/data/sandbox/ws/.warren";
const AUTO_OPEN = { enabled: true, token: "ghp_xyz", warrenBaseUrl: null } as const;
const NOTE = "## Understanding\nRetry the flaky call.\n\n## Chosen approach and why\nA loop.";
/** A dispatched agent whose prompt asks for the note, as the source-editing builtins do. */
const ASKED = {
	sections: { system: "Before your first edit, write /workspace/.warren/approach.md." },
};

describe("reapRun approach note (namphuongtran/warren#33)", () => {
	let ctx: Ctx;

	beforeEach(async () => {
		ctx = await setup(`${tmpdir()}/unused-host`, ASKED);
	});

	afterEach(async () => {
		await ctx.db.close();
	});

	async function reap(files: Record<string, string>, opts: { finalizeThrows?: boolean } = {}) {
		const fs = fakeFs(files).fs;
		const e = fakeExec({ revListCount: "2", nameOnlyDiff: "src/a.ts\0" });
		const forge = fakeForge();
		const deps = reapDeps(fakeBurrowClient(makeBurrow()), { fs, exec: e.exec });
		if (opts.finalizeThrows === true) {
			deps.runtimeProvider.finalize = async () => {
				throw new Error("finalize transport died");
			};
		}
		await reapRun({
			runId: ctx.runId,
			outcome: "succeeded",
			repos: ctx.repos,
			...deps,
			broker: ctx.broker,
			fs,
			exec: e.exec,
			autoOpenPr: AUTO_OPEN,
			forge,
		});
		return {
			run: await ctx.repos.runs.require(ctx.runId),
			events: await ctx.repos.events.listByRun(ctx.runId),
			prBody: forge.store.getPr("x/y", 1)?.body ?? "",
		};
	}

	test("stores the note and emits approach.recorded", async () => {
		const { run, events } = await reap({ [`${WS}/approach.md`]: NOTE });

		expect(run.approach).toEqual({ state: "recorded", markdown: NOTE, truncated: false });
		expect(events.find((ev) => ev.kind === "approach.recorded")).toMatchObject({
			stream: "system",
			payloadJson: { markdown: NOTE, truncated: false },
		});
		expect(run.state).toBe("succeeded");
	});

	test("flags a run without a note as missing and keeps it succeeded", async () => {
		const { run, events } = await reap({});

		expect(run.approach).toEqual({
			state: "missing",
			reason: "the run did not write .warren/approach.md",
		});
		expect(events.find((ev) => ev.kind === "approach.missing")).toMatchObject({
			payloadJson: { reason: "the run did not write .warren/approach.md" },
		});
		expect(run.state).toBe("succeeded");
		expect(run.failureReason).toBeNull();
	});

	test("records nothing for a run whose agent was not asked for a note", async () => {
		await ctx.db.close();
		ctx = await setup(`${tmpdir()}/unused-host`, { sections: { system: "Review the PR." } });
		const { run, events } = await reap({});

		expect(run.approach).toBeNull();
		expect(events.some((ev) => ev.kind.startsWith("approach."))).toBe(false);
	});

	test("still records a note that an unasked agent wrote", async () => {
		await ctx.db.close();
		ctx = await setup(`${tmpdir()}/unused-host`);
		const { run } = await reap({ [`${WS}/approach.md`]: NOTE });

		expect(run.approach).toEqual({ state: "recorded", markdown: NOTE, truncated: false });
	});

	test("does not call a note missing when finalize never collected it", async () => {
		const { run, events } = await reap({ [`${WS}/approach.md`]: NOTE }, { finalizeThrows: true });

		expect(run.approach).toBeNull();
		expect(events.some((ev) => ev.kind === "approach.missing")).toBe(false);
	});

	test("renders a deviation from the handoff's approach block in the PR body", async () => {
		const handoff = JSON.stringify({
			status: "done",
			summary: "Queued the call.",
			approach: { followed: false, deviation: "The retry loop raced\n## Fake section" },
		});
		const { prBody } = await reap({
			[`${WS}/approach.md`]: NOTE,
			[`${WS}/handoff.json`]: handoff,
		});

		expect(prBody).toContain(
			"**Approach:** deviated from the approach note: The retry loop raced ## Fake section",
		);
	});

	test("renders a followed approach in the PR body", async () => {
		const handoff = JSON.stringify({
			status: "done",
			summary: "Added the loop.",
			approach: { followed: true },
		});
		const { prBody } = await reap({ [`${WS}/handoff.json`]: handoff });

		expect(prBody).toContain("**Approach:** followed the approach note");
	});
});

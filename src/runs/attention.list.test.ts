/**
 * The runs list's attention reads (namphuongtran/warren#39) against a real
 * database: a list page's per-row reasons, and the ids the list's "needs
 * attention" filter keeps, both judged as the Needs attention page judges
 * its 30-day window.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { RunHandoffRecord, RunPrChecks } from "../core/wire.ts";
import { openDatabase, type WarrenDb } from "../db/client.ts";
import { createRepos, type Repos } from "../db/repos/index.ts";
import { readAttentionRunIds, readRunAttention, readRunListAttention } from "./attention.ts";
import { readNeedsInput } from "./needs-input-view.ts";

const NOW = new Date("2026-11-28T12:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;
const AGENT = { name: "claude-code", version: 1, sections: { system: "x" }, frontmatter: {} };
const PR = "https://github.com/os-eco/warren/pull/7";

const BLOCKED: RunHandoffRecord = {
	state: "recorded",
	handoff: {
		status: "blocked",
		summary: "The card has no progress slot.",
		verification: [],
		howToTry: [],
		openQuestions: [{ question: "Grow a progress slot?", options: [], recommendation: null }],
	},
};

const CHANGES_REQUESTED: RunPrChecks = {
	state: "passing",
	failing: [],
	commit: "4f1c2a9e",
	checkedAt: NOW.toISOString(),
	review: { state: "changes_requested", description: "Changes requested" },
};

describe("runs-list attention reads (namphuongtran/warren#39)", () => {
	let db: WarrenDb;
	let repos: Repos;
	let projectId: string;

	async function queued(
		daysAgo: number,
		extra: { parentRunId?: string; retryOf?: string; trigger?: string } = {},
	): Promise<string> {
		const at = new Date(NOW.getTime() - daysAgo * DAY_MS);
		const row = await repos.runs.create({
			agentName: "claude-code",
			projectId,
			prompt: "task",
			renderedAgentJson: AGENT,
			trigger: extra.trigger ?? "manual",
			...(extra.parentRunId !== undefined
				? { parentRunId: extra.parentRunId, cloneKind: "continue" as const }
				: {}),
			...(extra.retryOf !== undefined ? { retryOf: extra.retryOf } : {}),
			now: at,
		});
		return row.id;
	}

	async function finished(daysAgo: number, state: "succeeded" | "failed"): Promise<string> {
		const id = await queued(daysAgo);
		const at = new Date(NOW.getTime() - daysAgo * DAY_MS);
		await repos.runs.markRunning(id, at);
		await repos.runs.finalize(id, state, at, state === "failed" ? "timed_out" : null);
		return id;
	}

	async function onReviewedPr(daysAgo: number): Promise<string> {
		const id = await finished(daysAgo, "succeeded");
		await repos.runs.setPrUrl(id, PR);
		await repos.runs.setPrState(id, "open", null);
		await repos.runs.setPrChecks(id, CHANGES_REQUESTED);
		return id;
	}

	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
		repos = createRepos(db);
		await repos.agents.upsert({ name: "claude-code", renderedJson: AGENT });
		const project = await repos.projects.create({
			gitUrl: "https://github.com/os-eco/warren.git",
			localPath: "/tmp/warren-attention-list",
			defaultBranch: "main",
		});
		projectId = project.id;
	});

	afterEach(async () => {
		await db.close();
	});

	/** Reasons per id for one list page, the way the list handler reads them. */
	async function pageReasons(limit = 100, offset = 0): Promise<Map<string, readonly string[]>> {
		const page = await repos.runs.listAll({ limit, offset });
		const needsInputFor = await readNeedsInput(repos, page);
		const reasonsFor = await readRunListAttention(repos, page, {
			needsInput: (id) => needsInputFor(id).needsInput,
			now: NOW,
		});
		return new Map(page.map((run) => [run.id, reasonsFor(run.id)]));
	}

	describe("readRunListAttention", () => {
		test("gives each row the reasons the Needs attention page lists for it over 30 days", async () => {
			const blocked = await finished(1, "succeeded");
			await repos.runs.setHandoff(blocked, BLOCKED);
			const builder = await onReviewedPr(3);
			const fixer = await onReviewedPr(2);
			const failed = await finished(4, "failed");
			const retried = await finished(5, "failed");
			await queued(4.5, { retryOf: retried });
			const ciFixed = await finished(6, "failed");
			await queued(5.5, { parentRunId: ciFixed, trigger: "ci-fixer" });
			const gateNotRun = await finished(20, "succeeded");
			await repos.runs.setQualityGateOutcome(gateNotRun, "not_run");
			const quiet = await finished(7, "succeeded");
			const tooOld = await finished(40, "failed");
			const running = await queued(0.1);
			await repos.runs.markRunning(running, NOW);

			const reasons = await pageReasons();
			expect(reasons.get(blocked)).toEqual(["blocked"]);
			expect(reasons.get(fixer)).toEqual(["changes_requested"]);
			expect(reasons.get(builder)).toEqual([]);
			expect(reasons.get(failed)).toEqual(["failed"]);
			expect(reasons.get(retried)).toEqual([]);
			expect(reasons.get(ciFixed)).toEqual(["failed"]);
			expect(reasons.get(gateNotRun)).toEqual(["gate_not_run"]);
			expect(reasons.get(quiet)).toEqual([]);
			expect(reasons.get(tooOld)).toEqual([]);
			expect(reasons.get(running)).toEqual([]);

			const page = await readRunAttention(repos, { window: "30d", now: NOW });
			const listed = new Map(page.items.map((item) => [item.run.id, item.reasons]));
			for (const [id, rowReasons] of reasons) expect(rowReasons).toEqual(listed.get(id) ?? []);
		});

		test("judges a row by every run on its PR, not only the runs on the same list page", async () => {
			const builder = await onReviewedPr(3);
			const fixer = await onReviewedPr(2);

			const newestFirst = await pageReasons(1, 0);
			expect([...newestFirst]).toEqual([[fixer, ["changes_requested"]]]);
			const secondPage = await pageReasons(1, 1);
			expect([...secondPage]).toEqual([[builder, []]]);
		});
	});

	describe("readAttentionRunIds", () => {
		test("keeps the ids the Needs attention page lists over 30 days, for the list filter", async () => {
			const failed = await finished(2, "failed");
			const gateFailed = await finished(25, "succeeded");
			await repos.runs.setQualityGateOutcome(gateFailed, "failed");
			await finished(3, "succeeded");
			await finished(40, "failed");

			expect([...(await readAttentionRunIds(repos, NOW))].sort()).toEqual(
				[failed, gateFailed].sort(),
			);
		});
	});
});

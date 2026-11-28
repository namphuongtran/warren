/**
 * Reproduction for gh-25 (namphuongtran/warren#25). A handoff may say
 * `status: "blocked"` with an empty `openQuestions` list: the schema allows
 * it, and the run still needs input. Neither answer surface could act on
 * it. The run Summary showed "The agent left no open questions" and no
 * form, and on the Needs attention page "Dispatch continuation" stayed
 * disabled forever, so the run sat in "Blocked on you" until it aged out.
 *
 * The fix asks the operator what the agent should do next. The answer rides
 * the continuation prompt under "The operator's instructions".
 *
 * The fixture's blocked run asks two questions, so each test strips them
 * from the response with `page.route`. Asserts on the DOM and on the
 * dispatched prompt, never pixels.
 */

import { AxeBuilder } from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";
import type { RunHandoffRecord } from "../../../src/core/wire.ts";
import {
	AXE_TAGS,
	blockingViolations,
	formatA11yVerdict,
	loadAllowlist,
	reconcileA11y,
} from "../a11y-checks.ts";
import { harnessCases, openCase } from "../harness.ts";
import { expandManifest, PAGES, type PageCase, type PageSpec } from "../pages.ts";

const SEED = "gh-25";
const INSTRUCTIONS = "Use the staging credential in the vault and run the migration.";
const NEXT_STEP = "What should the agent do next?";

const { fixture } = harnessCases();
const allowlist = loadAllowlist();
const blockedRunId = fixture.ids.runs.failed;

interface HandoffCarrier {
	handoff?: RunHandoffRecord | null;
}

/** Drop the open questions from a run's recorded handoff. */
function withoutQuestions(run: HandoffCarrier): void {
	if (run.handoff?.state !== "recorded") return;
	run.handoff = { state: "recorded", handoff: { ...run.handoff.handoff, openQuestions: [] } };
}

/** Serve the blocked run with no open questions on `GET /attention`. */
async function stripAttentionQuestions(page: Page): Promise<void> {
	await page.route(/\/attention(\?|$)/, async (route) => {
		const res = await route.fetch();
		const body = (await res.json()) as { items: { run: HandoffCarrier & { id: string } }[] };
		for (const item of body.items) if (item.run.id === blockedRunId) withoutQuestions(item.run);
		await route.fulfill({ response: res, json: body });
	});
}

/** Serve the blocked run with no open questions on `GET /runs/:id`. */
async function stripRunQuestions(page: Page): Promise<void> {
	await page.route(`**/runs/${blockedRunId}`, async (route) => {
		if (route.request().method() !== "GET") return route.fallback();
		const res = await route.fetch();
		const body = (await res.json()) as { run: HandoffCarrier };
		withoutQuestions(body.run);
		await route.fulfill({ response: res, json: body });
	});
}

/** The new form passes the same axe rules as every page. */
async function expectAccessible(page: Page, c: PageCase): Promise<void> {
	const results = await new AxeBuilder({ page }).withTags([...AXE_TAGS]).analyze();
	const a11y = reconcileA11y(c, blockingViolations(results.violations), allowlist);
	expect(formatA11yVerdict(c.name, a11y)).toBe("");
}

/** The continuation prompt carries the operator's instructions, not answers. */
function expectInstructionsPrompt(prompt: string): void {
	expect(prompt).toMatch(/^Migrate the plan-runs table to the card primitive/);
	expect(prompt).toMatch(/```text\nThe card primitive has no slot/);
	expect(prompt).toContain(`## The operator's instructions\n\n${INSTRUCTIONS}`);
	expect(prompt).not.toContain("## The operator's answers");
	expect(prompt).not.toContain("```json");
}

const ATTENTION = PAGES.filter((p) => p.id === "attention");
const SUMMARY: readonly PageSpec[] = [
	{ id: "run-summary-blocked", route: "/runs/:id", path: (ids) => `/runs/${ids.runs.failed}` },
];

for (const c of expandManifest(ATTENTION, fixture.ids)) {
	test.describe(`${SEED} ${c.name}`, () => {
		test.use({ viewport: c.size, colorScheme: c.theme });

		test("answers a blocked run that asked no question", async ({ page }) => {
			const posted: Record<string, string>[] = [];
			await page.route("**/runs", async (route) => {
				if (route.request().method() !== "POST") return route.fallback();
				posted.push(route.request().postDataJSON() as Record<string, string>);
				await route.fulfill({
					status: 201,
					contentType: "application/json",
					body: JSON.stringify({ run: { id: "run_fxanswered02" }, sandbox: {} }),
				});
			});
			await stripAttentionQuestions(page);
			await openCase(page, c, fixture);

			const blocked = page.getByRole("region", { name: "Blocked on you" });
			const go = blocked.getByRole("button", { name: "Dispatch continuation" });
			const field = blocked.getByLabel(NEXT_STEP);
			await expect(blocked).toContainText("The card primitive has no slot");
			await expect(blocked.getByText(/progress slot/)).toHaveCount(0);
			await expect(field).toBeVisible();
			await expectAccessible(page, c);
			await expect(go).toBeDisabled();
			await field.fill(INSTRUCTIONS);
			await expect(go).toBeEnabled();
			await go.click();

			await expect(blocked.getByRole("button", { name: "Continuation dispatched" })).toBeDisabled();
			expect(posted).toHaveLength(1);
			const body = posted[0] ?? {};
			expect(body.continueFromRunId).toBe(blockedRunId);
			expectInstructionsPrompt(body.prompt ?? "");
		});
	});
}

for (const c of expandManifest(SUMMARY, fixture.ids)) {
	test.describe(`${SEED} ${c.name}`, () => {
		test.use({ viewport: c.size, colorScheme: c.theme });

		test("answers a blocked run that asked no question", async ({ page }) => {
			await stripRunQuestions(page);
			await openCase(page, c, fixture);

			const outcome = page.getByRole("region", { name: "Outcome" });
			const go = outcome.getByRole("button", { name: "Continue with instructions" });
			const field = outcome.getByLabel(NEXT_STEP);
			await expect(outcome).toContainText("Blocked on");
			await expect(outcome.getByText(/progress slot/)).toHaveCount(0);
			await expect(field).toBeVisible();
			await expectAccessible(page, c);
			await expect(go).toBeDisabled();
			await field.fill(INSTRUCTIONS);
			await expect(go).toBeEnabled();
			await go.click();

			await expect(page).toHaveURL(/\/dispatch$/);
			await expect(page.getByText(/CONTINUATION FROM/)).toBeVisible();
			const prompt = await page.getByPlaceholder("What should the agent do?").inputValue();
			expectInstructionsPrompt(prompt);
		});
	});
}

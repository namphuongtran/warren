/**
 * The Needs attention page (namphuongtran/warren#26) against the fixture
 * boot. The fixture already seeds a run for every section: the blocked run
 * with open questions, the open PR whose review asked for changes, failed
 * runs nothing retried, and the run that left no handoff. The empty and
 * error states shape `GET /attention` with `page.route`; the loading state
 * holds the request a window switch sends. Answering the blocked run posts
 * the continuation, intercepted so the fixture stays unchanged for every
 * other spec. Each state runs at phone and desktop sizes in both themes and
 * asserts on the DOM, never on pixels.
 *
 * Named `*.pw.ts`, not `*.spec.ts`, because `bun test` also discovers
 * `.spec.` files. Run it through `bun run check:ui-visual`.
 */

import { AxeBuilder } from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";

import {
	AXE_TAGS,
	blockingViolations,
	formatA11yVerdict,
	loadAllowlist,
	reconcileA11y,
} from "./a11y-checks.ts";
import { harnessCases, observe, openCase } from "./harness.ts";
import { expandManifest, PAGES, type PageCase } from "./pages.ts";
import { evaluateSmoke, formatVerdict, reconcile } from "./smoke-checks.ts";

const { fixture } = harnessCases();
const allowlist = loadAllowlist();
const ids = fixture.ids;

const ATTENTION = PAGES.filter((page) => page.id === "attention");

const ATTENTION_URL = /\/attention(\?|$)/;
const section = (page: Page, name: string) => page.getByRole("region", { name });

/** Smoke and axe on whatever state the page shows now. */
async function expectCleanPage(page: Page, c: PageCase, errors: string[]): Promise<void> {
	const smoke = reconcile(c, evaluateSmoke(await observe(page, errors)));
	expect(formatVerdict(c.name, smoke)).toBe("");
	const results = await new AxeBuilder({ page }).withTags([...AXE_TAGS]).analyze();
	const a11y = reconcileA11y(c, blockingViolations(results.violations), allowlist);
	expect(formatA11yVerdict(c.name, a11y)).toBe("");
}

for (const c of expandManifest(ATTENTION, ids)) {
	test.describe(c.name, () => {
		test.use({ viewport: c.size, colorScheme: c.theme });

		test("lists every category from the fixture", async ({ page }) => {
			await openCase(page, c, fixture);

			const blocked = section(page, "Blocked on you");
			await expect(blocked.getByRole("link", { name: ids.runs.failed })).toBeVisible();
			await expect(blocked).toContainText("Migrate the plan-runs table to the card primitive");
			await expect(blocked).toContainText("Waiting on your answer");
			await expect(blocked).toContainText("Failed: Timed out");
			await expect(blocked).toContainText("Gate failed");
			await expect(blocked).toContainText("The card primitive has no slot");

			const review = section(page, "Review asked for changes");
			await expect(review.getByRole("link", { name: ids.runs.prOpen })).toBeVisible();
			await expect(review).toContainText("Changes requested (fix round 1 of 2)");
			await expect(review).toContainText("3 shortcut flags");
			await expect(review.getByRole("link", { name: /Open the PR/ })).toHaveAttribute(
				"href",
				/\/pull\/1406$/,
			);

			const failed = section(page, "Failed");
			await expect(failed.getByRole("link", { name: "run_fx0000000203" })).toBeVisible();
			await expect(failed).toContainText("Failed: Provider error");

			const quality = section(page, "Quality signals");
			await expect(quality.getByRole("link", { name: ids.runs.succeeded })).toBeVisible();
			await expect(quality).toContainText("No valid handoff");

			// A run appears once, in its most urgent section.
			await expect(page.getByRole("link", { name: ids.runs.failed })).toHaveCount(1);
			// Settled work is not listed: the cancelled run, and runs whose PR merged.
			await expect(page.getByRole("link", { name: ids.runs.cancelled })).toHaveCount(0);
		});

		test("answering the blocked run dispatches its continuation", async ({ page }) => {
			const posted: unknown[] = [];
			await page.route("**/runs", async (route) => {
				if (route.request().method() !== "POST") return route.fallback();
				posted.push(route.request().postDataJSON());
				await route.fulfill({
					status: 201,
					contentType: "application/json",
					body: JSON.stringify({ run: { id: "run_fxanswered01" }, sandbox: {} }),
				});
			});
			await openCase(page, c, fixture);

			const blocked = section(page, "Blocked on you");
			const go = blocked.getByRole("button", { name: "Dispatch continuation" });
			await blocked.getByRole("button", { name: /Use the recommendation for question 1/ }).click();
			await expect(blocked.getByLabel(/progress slot/)).toHaveValue(/^Grow a footer slot\./);
			await go.click();

			await expect(page.getByText("Continuation dispatched").first()).toBeVisible();
			await expect(page.getByRole("link", { name: "Open run run_fxanswered01" })).toHaveAttribute(
				"href",
				"#/runs/run_fxanswered01",
			);
			await expect(blocked.getByRole("button", { name: "Continuation dispatched" })).toBeDisabled();
			expect(posted).toHaveLength(1);
			const body = posted[0] as Record<string, string>;
			expect(body.continueFromRunId).toBe(ids.runs.failed);
			expect(body.agent).toBe("claude-code");
			expect(body.project).toBe(ids.projects.withSeeds.id);
			expect(body.prompt).toMatch(/^Migrate the plan-runs table to the card primitive/);
			expect(body.prompt).toMatch(/## The operator's answers/);
			expect(body.prompt).toMatch(/1\. Grow a footer slot\. Other inventory lists/);
			expect(body.prompt).toMatch(/2\. None given\. Decide/);
		});

		test("shows the empty state", async ({ page }) => {
			await page.route(ATTENTION_URL, (route) =>
				route.fulfill({
					status: 200,
					contentType: "application/json",
					body: JSON.stringify({
						window: "7d",
						items: [],
						generatedAt: new Date(fixture.frozenNowMs).toISOString(),
					}),
				}),
			);
			const errors = await openCase(page, c, fixture);
			await expect(page.getByText("Nothing needs you right now")).toBeVisible();
			await expect(page.getByText(/No finished run from the last 7 days/)).toBeVisible();
			await expectCleanPage(page, c, errors);
		});

		test("shows the error state and recovers on retry", async ({ page }) => {
			let fail = true;
			await page.route(ATTENTION_URL, (route) =>
				fail
					? route.fulfill({
							status: 500,
							contentType: "application/json",
							body: JSON.stringify({ error: { code: "internal", message: "database is locked" } }),
						})
					: route.fallback(),
			);
			const errors = await openCase(page, c, fixture);
			const alert = page.getByRole("alert");
			await expect(alert).toContainText("The list could not be loaded");
			await expect(alert).toContainText("database is locked");
			await expectCleanPage(
				page,
				c,
				// The 500 itself logs a failed-resource console error; that is the state under test.
				errors.filter((e) => !e.includes("500")),
			);
			fail = false;
			await alert.getByRole("button", { name: "Try again" }).click();
			await expect(section(page, "Blocked on you")).toBeVisible();
		});

		test("shows the loading state while a window loads", async ({ page }) => {
			let release: () => void = () => {};
			const held = new Promise<void>((resolve) => {
				release = resolve;
			});
			await page.route(/\/attention\?window=30d/, async (route) => {
				await held;
				await route.fallback();
			});
			await openCase(page, c, fixture);
			await page.getByRole("button", { name: "30 days" }).click();
			await expect(
				page.getByRole("status").filter({ hasText: "Loading the runs that need you" }),
			).toBeAttached();
			await expect(page.getByText("Loading the runs that need you…")).toBeVisible();
			release();
			await expect(section(page, "Failed")).toBeVisible();
			await expect(page.getByRole("button", { name: "30 days" })).toHaveAttribute(
				"aria-pressed",
				"true",
			);
		});
	});
}

/**
 * The runs list's review signals (namphuongtran/warren#39) against the
 * fixture boot: the Changes, Quality, Judge, and attention cells on the
 * desktop table and the phone cards, and the Gate, PR, and Needs attention
 * filters, which the server applies so the total covers the filtered set.
 * Each case runs at phone and desktop sizes in both themes and asserts on the
 * DOM, never on pixels.
 *
 * Named `*.pw.ts`, not `*.spec.ts`, because `bun test` also discovers
 * `.spec.` files. Run it through `bun run check:ui-visual`.
 */

import { AxeBuilder } from "@axe-core/playwright";
import { expect, type Locator, type Page, test } from "@playwright/test";

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

const RUNS = PAGES.filter((page) => page.id === "runs");
const RUNS_LIST = /\/runs\?/;

/** Smoke and axe on whatever state the page shows now. */
async function expectCleanPage(page: Page, c: PageCase, errors: string[]): Promise<void> {
	// A toggled filter pill fades its colors (`transition-colors`). Let the
	// transitions land before axe samples contrast; spinners never finish, so
	// only CSS transitions are awaited.
	await page.evaluate(() =>
		Promise.all(
			document
				.getAnimations()
				.filter((a) => a instanceof CSSTransition)
				.map((a) => a.finished),
		),
	);
	const smoke = reconcile(c, evaluateSmoke(await observe(page, errors)));
	expect(formatVerdict(c.name, smoke)).toBe("");
	const results = await new AxeBuilder({ page }).withTags([...AXE_TAGS]).analyze();
	const a11y = reconcileA11y(c, blockingViolations(results.violations), allowlist);
	expect(formatA11yVerdict(c.name, a11y)).toBe("");
}

/** The server's own total for a filtered list, read with the fixture's operator token. */
async function serverTotal(page: Page, query: string): Promise<number> {
	const res = await page.request.get(`${fixture.baseUrl}/runs?${query}`, {
		headers: { authorization: `Bearer ${fixture.token}` },
	});
	expect(res.status()).toBe(200);
	return ((await res.json()) as { total: number }).total;
}

/** The desktop table row, or the phone card, that links to `runId`. */
function runEntry(page: Page, c: PageCase, runId: string): Locator {
	const link = page.getByRole("link", { name: runId, exact: true });
	if (c.viewport === "desktop") return page.getByRole("row").filter({ has: link });
	// The phone list holds the column strip (spans) and the card list, whose children are the cards.
	return page.getByTestId("runs-mobile-list").locator(":scope > div > div").filter({ has: link });
}

/** Open the filter controls: always shown on desktop, behind "＋ Filter" on a phone. */
async function filterControls(page: Page, c: PageCase): Promise<void> {
	if (c.viewport === "phone") await page.getByRole("button", { name: "＋ Filter" }).click();
}

for (const c of expandManifest(RUNS, ids)) {
	test.describe(c.name, () => {
		test.use({ viewport: c.size, colorScheme: c.theme });

		test("shows what each run changed, its quality, the judge's word, and who needs you", async ({
			page,
		}) => {
			await openCase(page, c, fixture);
			const prOpen = runEntry(page, c, ids.runs.prOpen);
			const failed = runEntry(page, c, ids.runs.failed);
			const running = runEntry(page, c, ids.runs.running);

			if (c.viewport === "desktop") {
				for (const header of ["Changes", "Quality", "Judge"]) {
					await expect(page.getByRole("columnheader", { name: header })).toBeVisible();
				}
				await expect(prOpen).toContainText("+92 −28");
				await expect(prOpen).toContainText("4 files");
				await expect(prOpen).toContainText("passed");
				await expect(prOpen).toContainText("3 flags");
				await expect(prOpen).toContainText("scope creep");
				await expect(prOpen.getByRole("img", { name: /Changes requested/ })).toBeVisible();

				// Missing data reads as a quiet placeholder, never an error.
				await expect(failed).toContainText("—");
				await expect(failed).toContainText("no flags");
				// The judge skipped one history run and scored others clean.
				await expect(page.getByRole("table")).toContainText("not judged");
				await expect(page.getByRole("table")).toContainText("clean");
				await expect(failed.getByRole("img", { name: /Waiting on your answer/ })).toBeVisible();
				await expect(runEntry(page, c, ids.runs.succeeded)).toContainText("none");
				await expect(running.getByRole("img")).toHaveCount(0);
			} else {
				await expect(prOpen).toContainText("+92 −28 · 4 files · 3 flags · judge scope creep");
				await expect(prOpen).toContainText("needs you");
				await expect(failed).toContainText("needs you");
				await expect(running).not.toContainText("needs you");
			}
		});

		test("filters on the server, so the total counts the filtered runs", async ({ page }) => {
			const requested: string[] = [];
			page.on("request", (req) => {
				if (RUNS_LIST.test(req.url()) && req.method() === "GET") requested.push(req.url());
			});
			const errors = await openCase(page, c, fixture);
			await filterControls(page, c);

			const gateFailed = await serverTotal(page, "gate=failed");
			await page.getByRole("combobox", { name: "Quality gate" }).selectOption("failed");
			await expect(runEntry(page, c, ids.runs.failed)).toBeVisible();
			await expect(runEntry(page, c, ids.runs.prOpen)).toHaveCount(0);
			expect(requested.some((url) => url.includes("gate=failed"))).toBe(true);

			await page.getByRole("button", { name: "Needs attention" }).click();
			const both = await serverTotal(page, "gate=failed&attention=1");
			await expect
				.poll(() => requested.some((url) => /gate=failed.*attention=1/.test(url)))
				.toBe(true);
			const footer =
				c.viewport === "desktop"
					? page.getByText(new RegExp(`of ${both}$`))
					: page.getByText(new RegExp(`OF ${both} · FILTERED`));
			await expect(footer).toBeVisible();
			expect(both).toBeLessThanOrEqual(gateFailed);
			await expectCleanPage(page, c, errors);
		});

		test("says no run matches when the filters leave nothing", async ({ page }) => {
			const errors = await openCase(page, c, fixture);
			await filterControls(page, c);
			expect(await serverTotal(page, "gate=stale&attention=1")).toBe(0);
			await page.getByRole("combobox", { name: "Quality gate" }).selectOption("stale");
			await page.getByRole("button", { name: "Needs attention" }).click();
			const empty = page.getByText("No runs match this filter").filter({ visible: true });
			await expect(empty).toBeVisible();
			await expectCleanPage(page, c, errors);
		});
	});
}

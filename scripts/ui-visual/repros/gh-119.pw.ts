/**
 * Reproduction for gh-119 (namphuongtran/warren#119). On a 393px phone the
 * console shell's <main> is the page's scroll container. The Agents page
 * fills it with registry cards that hold no link or button, so <main>
 * scrolls but a keyboard user has nothing to focus inside it and cannot
 * scroll it. axe reports `scrollable-region-focusable` (serious). The
 * Instance page had the same defect, grandfathered in a11y-allowlist.json.
 *
 * The fix makes the shell's <main> itself focusable with an accessible
 * name, so every page's scroll region is keyboard-reachable however little
 * interactive content it holds.
 *
 * Asserts on axe's verdict and the tab order, never pixels.
 */

import { AxeBuilder } from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

import { harnessCases, openCase } from "../harness.ts";

const SEED = "gh-119";
const RULE = "scrollable-region-focusable";
/** Pages whose phone <main> scrolls with no focusable content inside it. */
const SCROLLING_PHONE_PAGES = ["agents", "instance"];

const { fixture, cases } = harnessCases();

for (const c of cases.filter(
	(x) => SCROLLING_PHONE_PAGES.includes(x.page.id) && x.viewport === "phone" && x.theme === "light",
)) {
	test.describe(`${SEED} ${c.name}`, () => {
		test.use({ viewport: c.size, colorScheme: c.theme });

		test("lets a keyboard user reach the scrolling main region", async ({ page }) => {
			await openCase(page, c, fixture);
			const results = await new AxeBuilder({ page }).withRules([RULE]).analyze();
			const targets = results.violations.flatMap((v) => v.nodes.map((n) => n.target.join(" ")));
			expect.soft(targets, `${RULE} violations`).toEqual([]);

			// Assert the attribute, not a Tab walk: Chromium's keyboard-focusable
			// scrollers already let Tab reach a bare scroller, so a walk passes
			// before the fix. Safari does not, and axe does not count on it.
			const main = page.getByRole("main");
			await expect(main, "main is in the tab order").toHaveAttribute("tabindex", "0");
			await expect(main, "main has an accessible name").toHaveAccessibleName(/.+/);
		});
	});
}

/**
 * Reproduction for gh-156 (namphuongtran/warren#156). Every `Alert`
 * variant set its text in the `*-foreground` ink, which is meant for a
 * solid status fill, on a 10% tint of the status color. That gives dark
 * text on a dark surface in the dark theme and near-white text on a white
 * surface in the light theme, so axe reports `color-contrast` (serious) on
 * the alert's title and body.
 *
 * The fixture never renders an error Alert, so this spec fails `GET /runs`
 * with a 500 envelope and checks the Runs page's "Failed to load runs" alert
 * at every viewport and theme. Asserts on axe's verdict, never pixels.
 */

import { AxeBuilder } from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

import { harnessCases, openCase } from "../harness.ts";

const SEED = "gh-156";
const RULE = "color-contrast";
/** The runs list only: `/runs/:id` and the event stream keep their real answers. */
const RUNS_LIST = /\/runs(\?[^/]*)?$/;

const { fixture, cases } = harnessCases();

for (const c of cases.filter((x) => x.page.id === "runs")) {
	test.describe(`${SEED} ${c.name}`, () => {
		test.use({ viewport: c.size, colorScheme: c.theme });

		test("gives the danger alert's text enough contrast", async ({ page }) => {
			await page.route(RUNS_LIST, (route) =>
				route.fulfill({
					status: 500,
					contentType: "application/json",
					body: JSON.stringify({ error: { code: "internal", message: "database is locked" } }),
				}),
			);
			await openCase(page, c, fixture);
			const alert = page.getByRole("alert").filter({ hasText: "Failed to load runs" });
			await expect(alert).toContainText("database is locked");

			const results = await new AxeBuilder({ page })
				.include("[role=alert]")
				.withRules([RULE])
				.analyze();
			const targets = results.violations.flatMap((v) => v.nodes.map((n) => n.target.join(" ")));
			expect(targets, `${RULE} violations inside the alert`).toEqual([]);
		});
	});
}

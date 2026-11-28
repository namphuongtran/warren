/**
 * The run detail Summary tab (namphuongtran/warren#38) against the three
 * fixture shapes `fixture-summary.ts` seeds: a full run, a blocked run, and
 * a run with no extras. Each runs at every viewport and theme through the
 * same smoke and axe checks the page manifest gets, then asserts the
 * sections and their empty states on the DOM, never on pixels.
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
import { expandManifest, type PageSpec } from "./pages.ts";
import { evaluateSmoke, formatVerdict, reconcile } from "./smoke-checks.ts";

const { fixture } = harnessCases();
const allowlist = loadAllowlist();

const SUMMARY_PAGES: readonly PageSpec[] = [
	{ id: "run-summary-full", route: "/runs/:id", path: (ids) => `/runs/${ids.runs.prOpen}` },
	{ id: "run-summary-blocked", route: "/runs/:id", path: (ids) => `/runs/${ids.runs.failed}` },
	{ id: "run-summary-bare", route: "/runs/:id", path: (ids) => `/runs/${ids.runs.succeeded}` },
];

const section = (page: Page, name: string) => page.getByRole("region", { name });
const tab = (page: Page, name: string) =>
	page.getByRole("navigation", { name: "Run views" }).getByRole("link", { name });

const ASSERTIONS: Record<string, (page: Page) => Promise<void>> = {
	"run-summary-full": async (page) => {
		await expect(section(page, "Approach")).toContainText("Chosen approach and why");
		await expect(section(page, "Approach")).toContainText("Deviated from the plan");
		await expect(section(page, "Outcome")).toContainText("Done");
		await expect(section(page, "Outcome")).toContainText("bun test src/ui/src/pages/telemetry");
		await expect(section(page, "Quality")).toContainText("Passed");
		await expect(section(page, "Quality")).toContainText("scope creep");
		// namphuongtran/warren#37: shortcut flags, each linked to its file and line.
		const flags = section(page, "Quality").getByRole("list", { name: "Shortcut flags" });
		await expect(section(page, "Quality")).toContainText("3 flags");
		await expect(flags).toContainText("Git hooks bypassed");
		await expect(flags).toContainText("Protected file edited");
		await expect(flags.getByRole("link", { name: /tab-strip\.tsx:42/ })).toHaveAttribute(
			"href",
			/\/blob\/.+\/src\/ui\/src\/pages\/telemetry\/tab-strip\.tsx#L42$/,
		);
		await expect(section(page, "Changes")).toContainText("4 files changed");
		await expect(
			section(page, "Changes").getByRole("link", { name: /Files on the PR/ }),
		).toHaveAttribute("href", /\/pull\/1406\/files$/);
		await expect(
			section(page, "Delivery").getByRole("link", { name: /Open the PR/ }),
		).toBeVisible();
		// namphuongtran/warren#41: the PR head's failing check, named.
		await expect(section(page, "Delivery")).toContainText("Failing");
		await expect(
			section(page, "Delivery").getByRole("list", { name: "Failed checks" }),
		).toContainText("e2e (phone, dark theme)");
		// namphuongtran/warren#38: the review verdict, in the reviewer's own words.
		await expect(
			section(page, "Delivery").getByText("Changes requested", { exact: true }),
		).toBeVisible();
		await expect(section(page, "Delivery")).toContainText("fix round 1 of 2");

		await section(page, "Quality").getByRole("link", { name: "events 2–5" }).click();
		await expect(page).toHaveURL(/tab=activity&seq=2-5/);
		await expect(tab(page, "Activity")).toHaveAttribute("aria-current", "page");
		await expect(page.locator('details[aria-current="true"]')).toHaveCount(4);
	},
	"run-summary-blocked": async (page) => {
		await expect(section(page, "Outcome")).toContainText("Blocked");
		await expect(section(page, "Outcome")).toContainText("Blocked on");
		await expect(section(page, "Outcome")).toContainText("progress slot");
		await expect(section(page, "Quality")).toContainText("Failed");
		await expect(section(page, "Quality")).toContainText("The judge has not scored this run");
		await expect(section(page, "Quality")).toContainText("None found");

		// namphuongtran/warren#25: a question shows the options the agent weighed
		// and the answer it recommends.
		const outcome = section(page, "Outcome");
		await expect(outcome.getByRole("list", { name: "Options" })).toContainText(
			"Move the progress bar under the card",
		);
		await expect(outcome).toContainText("Recommended: Grow a footer slot.");

		// The answer controls: each open question labels its own answer field,
		// the recommendation fills it in one click, and answering opens Dispatch
		// as a continuation with the answers. A blank answer takes the
		// recommendation, so question 1's lets the operator continue at once.
		const go = outcome.getByRole("button", { name: "Continue with answers" });
		await expect(go).toBeEnabled();
		await outcome.getByRole("button", { name: /Use the recommendation for question 1/ }).click();
		await expect(outcome.getByLabel(/progress slot/)).toHaveValue(/^Grow a footer slot\./);
		await go.click();
		await expect(page).toHaveURL(/\/dispatch$/);
		await expect(page.getByText(/CONTINUATION FROM/)).toBeVisible();
		const prompt = page.getByPlaceholder("What should the agent do?");
		await expect(prompt).toHaveValue(
			/## The previous run's handoff\n[\s\S]*```text\nThe card primitive has no slot/,
		);
		await expect(prompt).toHaveValue(/"recommendation": "Grow a footer slot\./);
		await expect(prompt).toHaveValue(/## The operator's answers/);
		await expect(prompt).toHaveValue(/1\. Grow a footer slot\. Other inventory lists/);
		await expect(prompt).toHaveValue(/2\. None given\. Decide/);
	},
	"run-summary-bare": async (page) => {
		await expect(section(page, "Approach")).toContainText("The agent wrote no approach note");
		await expect(section(page, "Outcome")).toContainText(
			"The agent ended without writing a handoff report",
		);
		await expect(section(page, "Quality")).toContainText("No gate");
		await expect(section(page, "Quality")).toContainText("Not scanned");
		await expect(section(page, "Changes")).toContainText("The run changed no files");
		await expect(section(page, "Delivery")).toContainText("No pull request was opened");
	},
};

for (const c of expandManifest(SUMMARY_PAGES, fixture.ids)) {
	test.describe(c.name, () => {
		test.use({ viewport: c.size, colorScheme: c.theme });

		test("summary", async ({ page }) => {
			const errors = await openCase(page, c, fixture);
			await expect(tab(page, "Summary")).toHaveAttribute("aria-current", "page");
			const smoke = reconcile(c, evaluateSmoke(await observe(page, errors)));
			expect(formatVerdict(c.name, smoke)).toBe("");
			const results = await new AxeBuilder({ page }).withTags([...AXE_TAGS]).analyze();
			const a11y = reconcileA11y(c, blockingViolations(results.violations), allowlist);
			expect(formatA11yVerdict(c.name, a11y)).toBe("");
			const assert = ASSERTIONS[c.page.id];
			if (assert === undefined) throw new Error(`no assertions for ${c.page.id}`);
			await assert(page);
		});
	});
}

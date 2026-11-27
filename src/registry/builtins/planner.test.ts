import { describe, expect, test } from "bun:test";
import { parseRunHandoff } from "../../core/wire.ts";
import { buildPiArgv } from "../../runtime/adapters/pi-argv.ts";
import {
	ALL_PROMPT_CAPABILITIES,
	NO_PROMPT_CAPABILITIES,
	withGatedPromptFragments,
} from "../prompt-gating.ts";
import { PLANNER_BUILTIN } from "./planner.ts";

/** The system prompt a run sees on a project with seeds + mulch. */
const TRACKED_SYSTEM =
	withGatedPromptFragments(PLANNER_BUILTIN, ALL_PROMPT_CAPABILITIES).sections.system ?? "";
/** The system prompt a run sees on a bare repo with no tracker. */
const UNTRACKED_SYSTEM =
	withGatedPromptFragments(PLANNER_BUILTIN, NO_PROMPT_CAPABILITIES).sections.system ?? "";

describe("PLANNER_BUILTIN", () => {
	// namphuongtran/warren#35: Plot, its attachments, the interactive run
	// primitive, and the brainstorm/formalize flow were all deleted, so the
	// prompt must not send the agent looking for any of them.
	test("names no deleted surface in the prompt", () => {
		for (const system of [TRACKED_SYSTEM, UNTRACKED_SYSTEM]) {
			expect(system).not.toMatch(/\bplot\b/i);
			expect(system).not.toMatch(/attachment/i);
			expect(system).not.toMatch(/brainstorm/i);
			expect(system).not.toMatch(/formalize/i);
			expect(system).not.toMatch(/interactive/i);
		}
		expect(PLANNER_BUILTIN.frontmatter.tags).not.toContain("interactive");
	});

	test("asks for a spec with every section the issue names (namphuongtran/warren#35)", () => {
		for (const heading of [
			"Goal",
			"Non-goals",
			"Constraints",
			"Acceptance criteria",
			"Affected modules",
			"Decisions",
			"Open questions",
		]) {
			expect(UNTRACKED_SYSTEM).toContain(`### ${heading}`);
		}
		expect(UNTRACKED_SYSTEM).toContain("Never ask a question without a recommendation");
	});

	// The question loop rides the handoff report (#21) and continuation (#25):
	// every example the prompt shows must validate the way reap validates it.
	test("shows a blocked handoff whose questions carry a recommendation, and a final one", () => {
		const examples = [...UNTRACKED_SYSTEM.matchAll(/```json\n([\s\S]*?)\n```/g)]
			.map((match) => match[1] ?? "")
			.filter((body) => /"status": "(blocked|done)"/.test(body));
		const records = examples.map((body) => parseRunHandoff(body));
		expect(records).toHaveLength(2);
		const [blocked, final] = records;
		if (blocked?.state !== "recorded" || final?.state !== "recorded") {
			throw new Error(`examples must validate: ${JSON.stringify(records)}`);
		}
		expect(blocked.handoff.status).toBe("blocked");
		expect(blocked.handoff.openQuestions.length).toBeGreaterThan(0);
		for (const question of blocked.handoff.openQuestions) {
			expect(question.question).toMatch(/\?$/);
			expect(question.options.length).toBeGreaterThan(1);
			expect(question.recommendation).toMatch(/.+ Why: .+/);
		}
		expect(final.handoff.status).toBe("done");
		expect(final.handoff.openQuestions).toEqual([]);
	});

	test("tells a continuation to apply the answers to the draft and finalize", () => {
		expect(UNTRACKED_SYSTEM).toContain("## Continuing a spec");
		expect(UNTRACKED_SYSTEM).toMatch(/answers questions from an earlier planner run/);
		expect(UNTRACKED_SYSTEM).toMatch(/Otherwise finalize the spec/);
	});

	test("writes the spec into the seeds issue and files a plan only once it is final", () => {
		expect(TRACKED_SYSTEM).toContain("<!-- warren:spec:start -->");
		expect(TRACKED_SYSTEM).toContain("<!-- warren:spec:end -->");
		expect(TRACKED_SYSTEM).toContain("sd update <id> --description");
		expect(TRACKED_SYSTEM).toContain("sd plan submit <id>");
		expect(TRACKED_SYSTEM).toContain("Do not submit a plan while questions remain");
		// mx-77117c: the 0-based blocks index is the classic off-by-one.
		expect(TRACKED_SYSTEM).toContain("0-BASED");
	});

	// warren-cb46: a project with no tracker gets no sd / .seeds/ assertions,
	// and the handoff summary is the only place the spec survives.
	test("keeps the spec in the handoff summary when the project has no tracker", () => {
		expect(UNTRACKED_SYSTEM).not.toMatch(/\bsd /);
		expect(UNTRACKED_SYSTEM).not.toContain(".seeds/");
		expect(UNTRACKED_SYSTEM).toContain("put the whole spec in the handoff report's `summary`");
	});

	test("forbids source edits, dispatch, and git writes in the prompt", () => {
		expect(UNTRACKED_SYSTEM).toContain("Do not edit, create, or delete source files");
		expect(UNTRACKED_SYSTEM).toContain("Do not dispatch runs");
		expect(UNTRACKED_SYSTEM).toContain("Do not run `git` write operations");
	});

	// The issue asks for the write scope to be enforced by the harness where
	// it can be, not only in prose: pi drops its edit tool for the planner.
	test("turns off pi's edit tool at the harness", () => {
		const argv = buildPiArgv(PLANNER_BUILTIN.frontmatter);
		const flag = argv.indexOf("--exclude-tools");
		expect(flag).toBeGreaterThan(-1);
		expect(argv[flag + 1]?.split(",")).toContain("edit");
	});

	test("declares runtime = 'pi' so dispatch composes on the real runtime", () => {
		// warren-ebca: planner's name matches no runtime adapter.
		expect(PLANNER_BUILTIN.frontmatter.runtime).toBe("pi");
	});

	test("requires open network for reading external references", () => {
		expect(PLANNER_BUILTIN.sections.burrow_config).toContain('network = "open"');
	});
});

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { isKnownRuntimeId, parseRunHandoff, RUN_APPROACH_HEADINGS } from "../../core/wire.ts";
import { openDatabase, type WarrenDb } from "../../db/client.ts";
import { AgentsRepo } from "../../db/repos/agents.ts";
import { DrizzleAdapter } from "../../db/repos/drizzle-adapter.ts";
import {
	AgentNameSchema,
	parseRenderedAgent,
	type RenderResponse,
	readRuntimeId,
} from "../schema.ts";
import {
	BUILTIN_AGENT_NAMES,
	BUILTIN_AGENTS,
	CLAUDE_CODE_BUILTIN,
	CODEX_BUILTIN,
	HEALER_BUILTIN,
	PI_BUILTIN,
	PLANNER_BUILTIN,
	PR_FIXER_BUILTIN,
	REVIEWER_BUILTIN,
	readAgentSource,
	seedBuiltinAgents,
	stampAgentSource,
} from "./index.ts";
import {
	APPROACH_FRAGMENT,
	GATE_FINAL_RUN_RULE,
	VALIDATION_DISCIPLINE_BULLETS,
} from "./prompt-fragments.ts";

describe("BUILTIN_AGENTS", () => {
	test("includes claude-code, pi, planner, pr-fixer, and healer", () => {
		expect(BUILTIN_AGENT_NAMES.has("claude-code")).toBe(true);
		expect(BUILTIN_AGENT_NAMES.has("sapling")).toBe(false);
		expect(BUILTIN_AGENT_NAMES.has("pi")).toBe(true);
		expect(BUILTIN_AGENT_NAMES.has("brainstorm")).toBe(false);
		expect(BUILTIN_AGENT_NAMES.has("planner")).toBe(true);
		expect(BUILTIN_AGENT_NAMES.has("pr-fixer")).toBe(true);
		expect(BUILTIN_AGENT_NAMES.has("leveret")).toBe(false);
		expect(BUILTIN_AGENT_NAMES.has("healer")).toBe(true);
		expect(BUILTIN_AGENT_NAMES.has("codex")).toBe(true);
		expect(BUILTIN_AGENT_NAMES.has("reviewer")).toBe(true);
	});

	// namphuongtran/warren#18: the controller reads the verdict from the
	// handoff's `review` block (extensions/campaign-controller/src/review/verdict.ts),
	// so every example the prompt shows must validate as a recorded review.
	test("reviewer is read-only and writes its verdict into the handoff report (namphuongtran/warren#18)", () => {
		const system = REVIEWER_BUILTIN.sections.system ?? "";
		const examples = [...system.matchAll(/```json\n([\s\S]*?)\n```/g)]
			.map((match) => match[1] ?? "")
			.filter((body) => body.includes('"review"'));
		expect(examples.map((body) => parseRunHandoff(body))).toEqual([
			expect.objectContaining({
				state: "recorded",
				handoff: expect.objectContaining({
					review: expect.objectContaining({ verdict: "approve" }),
				}),
			}),
			expect.objectContaining({
				state: "recorded",
				handoff: expect.objectContaining({
					review: expect.objectContaining({ verdict: "request_changes" }),
				}),
			}),
		]);
		expect(system).not.toContain("<warren-review-verdict>");
		expect(system).toContain("Do not edit, create, or delete files");
		expect(system).toContain("Do not run `git commit`");
		expect(system).not.toContain("$WARREN_QUALITY_GATE");
		const gated = Object.values(REVIEWER_BUILTIN.gatedPrompts ?? {}).join("\n");
		expect(gated).not.toContain("sd create");
		expect(gated).not.toContain("sd close");
		expect(gated).toContain("Do not run `ml record`");
	});

	test("codex dispatches onto the codex runtime with an OpenAI model warren can price (namphuongtran/warren#17)", () => {
		expect(readRuntimeId(CODEX_BUILTIN)).toBe("codex");
		expect(CODEX_BUILTIN.frontmatter.provider).toBe("openai");
		expect(CODEX_BUILTIN.frontmatter.model).toBe("gpt-5.3-codex");
	});

	test("each builtin name passes the shared kebab grammar (warren-2b75)", () => {
		for (const builtin of BUILTIN_AGENTS) {
			expect(AgentNameSchema.safeParse(builtin.name).success).toBe(true);
		}
	});

	test("each builtin has a non-empty system section (warren's required schema field)", () => {
		for (const builtin of BUILTIN_AGENTS) {
			expect(builtin.sections.system?.length ?? 0).toBeGreaterThan(0);
		}
	});

	test("each builtin asks for the handoff report with its schema (namphuongtran/warren#21)", () => {
		for (const builtin of BUILTIN_AGENTS) {
			const system = builtin.sections.system ?? "";
			expect(system).toContain(".warren/handoff.json");
			for (const field of ["status", "summary", "verification", "howToTry", "openQuestions"]) {
				expect(system).toContain(`"${field}"`);
			}
		}
	});

	// namphuongtran/warren#33: the coding agents write the approach note before
	// their first edit; the read-only agents make no edits, so they get no note.
	test("source-editing builtins ask for the approach note before the first edit (namphuongtran/warren#33)", () => {
		const editing = [
			CLAUDE_CODE_BUILTIN,
			PI_BUILTIN,
			CODEX_BUILTIN,
			PR_FIXER_BUILTIN,
			HEALER_BUILTIN,
		];
		for (const builtin of editing) {
			const system = builtin.sections.system ?? "";
			expect(system).toContain(APPROACH_FRAGMENT);
			for (const heading of RUN_APPROACH_HEADINGS) expect(system).toContain(`## ${heading}`);
		}
		for (const builtin of BUILTIN_AGENTS.filter((b) => !editing.includes(b))) {
			expect(builtin.sections.system ?? "").not.toContain(".warren/approach.md");
		}
		expect(APPROACH_FRAGMENT).toContain("before your first edit");
		expect(APPROACH_FRAGMENT).toContain("one-line approach");
	});

	// The adherence examples the fragment shows must validate against the core parser.
	test("the approach fragment's handoff examples validate (namphuongtran/warren#33)", () => {
		const examples = [...APPROACH_FRAGMENT.matchAll(/`("approach": \{[^`]*\})`/g)].map(
			(match) => match[1] ?? "",
		);
		expect(examples).toHaveLength(2);
		for (const example of examples) {
			const record = parseRunHandoff(`{"status":"done","summary":"x",${example}}`);
			expect(record).toMatchObject({ state: "recorded", handoff: { approach: {} } });
		}
	});

	test("each builtin round-trips through parseRenderedAgent (the canopy schema)", () => {
		for (const builtin of BUILTIN_AGENTS) {
			const renderResponse: RenderResponse = {
				success: true,
				command: "render",
				name: builtin.name,
				version: builtin.version,
				sections: Object.entries(builtin.sections).map(([name, body]) => ({ name, body })),
				resolvedFrom: [...builtin.resolvedFrom],
				frontmatter: { ...builtin.frontmatter },
			};
			const parsed = parseRenderedAgent(renderResponse, builtin.name);
			expect(parsed.name).toBe(builtin.name);
			expect(parsed.sections.system).toBe(builtin.sections.system);
		}
	});

	// warren-c4be: every shipped built-in must resolve to a runtime burrow
	// actually knows. warren-ebca was exactly this failing at dispatch instead.
	test("each builtin resolves to a known runtime id (warren-c4be)", () => {
		for (const builtin of BUILTIN_AGENTS) {
			expect(isKnownRuntimeId(readRuntimeId(builtin))).toBe(true);
		}
	});

	test("each builtin's frontmatter declares source = 'builtin' for provenance", () => {
		for (const builtin of BUILTIN_AGENTS) {
			expect(builtin.frontmatter.source).toBe("builtin");
		}
	});

	// warren-3305: no builtin runtime consumes steering mid-run (pi reads
	// stdin only at a turn boundary and warren closes stdin at agent_end), so
	// every builtin must declare spawn-only — the flag drives the 409 that
	// replaced the silent steer.sent no-op.
	test("each builtin declares steering: 'spawn-only' (warren-3305)", () => {
		for (const builtin of BUILTIN_AGENTS) {
			expect(builtin.frontmatter.steering).toBe("spawn-only");
		}
	});

	// warren-6a34: the operating-contract block for the three interactive
	// coding built-ins must frame the quality gate as terminal, not advisory.
	// This regression test prevents the bullet from drifting back to softer
	// "run gates before committing" wording that lets agents declare success
	// on a red tree.
	test("claude-code / pi / codex declare the quality gate as terminal (warren-6a34)", () => {
		for (const builtin of [CLAUDE_CODE_BUILTIN, PI_BUILTIN, CODEX_BUILTIN]) {
			const system = builtin.sections.system ?? "";
			expect(system).toContain("$WARREN_QUALITY_GATE");
			expect(system).toContain("NOT done until the gate exits zero");
			expect(system).toContain("Do not declare the task complete");
			expect(system).toContain("red gate");
		}
	});

	// warren-7e82: the old "run it before committing and again before
	// reporting completion" wording made agents re-run the complete gate on
	// unchanged inputs. Every source-editing builtin keeps the mandatory
	// final green run but carries the no-unchanged-rerun discipline instead.
	test("source-editing builtins keep one final green gate without unchanged reruns (warren-7e82)", () => {
		for (const builtin of [
			CLAUDE_CODE_BUILTIN,
			PI_BUILTIN,
			CODEX_BUILTIN,
			PR_FIXER_BUILTIN,
			HEALER_BUILTIN,
		]) {
			const system = builtin.sections.system ?? "";
			expect(system).not.toContain("again before reporting completion");
			expect(system).toContain(GATE_FINAL_RUN_RULE);
			expect(system).toContain(VALIDATION_DISCIPLINE_BULLETS);
			expect(system).toContain("NOT done until");
			expect(system).toContain("red gate");
		}
	});

	test("validation discipline names the measured waste patterns (warren-7e82)", () => {
		expect(GATE_FINAL_RUN_RULE).toContain("Rerun it only when relevant inputs changed");
		expect(GATE_FINAL_RUN_RULE).toMatch(/committing or reporting completion does not by itself/);
		expect(VALIDATION_DISCIPLINE_BULLETS).toContain("Prepare dependencies once");
		expect(VALIDATION_DISCIPLINE_BULLETS).toContain("configured test entry points");
		expect(VALIDATION_DISCIPLINE_BULLETS).toContain("focused tests");
		expect(VALIDATION_DISCIPLINE_BULLETS).toContain("--bail");
		expect(VALIDATION_DISCIPLINE_BULLETS).toContain("pipefail");
		expect(VALIDATION_DISCIPLINE_BULLETS).toMatch(/Never re-run an unchanged command/);
		expect(VALIDATION_DISCIPLINE_BULLETS).toContain("--no-verify");
	});
});

describe("readAgentSource", () => {
	test("returns 'builtin' when frontmatter.source === 'builtin'", () => {
		expect(readAgentSource(CLAUDE_CODE_BUILTIN)).toBe("builtin");
		expect(readAgentSource(PI_BUILTIN)).toBe("builtin");
		expect(readAgentSource(PLANNER_BUILTIN)).toBe("builtin");
	});

	test("returns 'library' for arbitrary library-shaped renderedJson", () => {
		expect(readAgentSource({ name: "foo", sections: { system: "..." }, frontmatter: {} })).toBe(
			"library",
		);
		// Canopy doesn't set frontmatter.source, so unset frontmatter falls back to library.
		expect(readAgentSource({ name: "foo" })).toBe("library");
	});

	test("returns 'library' for malformed renderedJson", () => {
		expect(readAgentSource(null)).toBe("library");
		expect(readAgentSource("not-an-object")).toBe("library");
		expect(readAgentSource(42)).toBe("library");
	});
});

describe("stampAgentSource", () => {
	test("returns a new agent with frontmatter.source set to the given source", () => {
		const stamped = stampAgentSource(CLAUDE_CODE_BUILTIN, "library");
		expect(stamped).not.toBe(CLAUDE_CODE_BUILTIN);
		expect(stamped.frontmatter.source).toBe("library");
		// Original is untouched.
		expect(CLAUDE_CODE_BUILTIN.frontmatter.source).toBe("builtin");
	});

	test("preserves other frontmatter fields", () => {
		const stamped = stampAgentSource(CLAUDE_CODE_BUILTIN, "library");
		expect(stamped.frontmatter.tags).toEqual(["agent"]);
	});
});

describe("PR_FIXER_BUILTIN", () => {
	test("is registered as a source-editing CI-repair agent (warren-05ea)", () => {
		expect(PR_FIXER_BUILTIN.name).toBe("pr-fixer");
		expect(PR_FIXER_BUILTIN.frontmatter.source).toBe("builtin");
		// Unlike the patrol agents it has no auto_plan_run frontmatter — the
		// CI poller dispatches it directly, not via reap's plan-run path.
		expect(PR_FIXER_BUILTIN.frontmatter.auto_plan_run).toBeUndefined();
	});

	test("declares runtime = 'pi' so dispatch composes on the real runtime", () => {
		expect(PR_FIXER_BUILTIN.frontmatter.runtime).toBe("pi");
	});

	test("system prompt frames the quality gate as terminal and forbids a new PR", () => {
		const system = PR_FIXER_BUILTIN.sections.system ?? "";
		expect(system).toContain("$WARREN_QUALITY_GATE");
		expect(system).toContain("NOT done until the gate exits zero");
		expect(system).toMatch(/do NOT open a new pull request/i);
		expect(system).toMatch(/Do not run `git push`/);
	});

	test("system prompt forbids deleting/skipping failing tests as a workaround", () => {
		const system = PR_FIXER_BUILTIN.sections.system ?? "";
		expect(system).toMatch(/disable, skip, or delete failing tests/i);
	});
});

describe("seedBuiltinAgents", () => {
	let db: WarrenDb;
	let repo: AgentsRepo;

	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
		repo = new AgentsRepo(DrizzleAdapter.for(db));
	});

	afterEach(async () => {
		await db.close();
	});

	test("inserts every builtin into an empty registry", async () => {
		const now = () => new Date("2026-05-10T00:00:00.000Z");
		const result = await seedBuiltinAgents(repo, undefined, now);
		expect([...result.seeded].sort()).toEqual([...BUILTIN_AGENT_NAMES].sort());
		expect(result.skipped).toEqual([]);
		const stored = await repo.get("claude-code");
		expect(stored).not.toBeNull();
		expect(readAgentSource(stored?.renderedJson)).toBe("builtin");
	});

	// warren-c4be: registration is the boundary that can still answer 4xx, but
	// seeding is a BOOT path — it refuses the row loudly instead of throwing,
	// so a legacy/seed-file definition can never take the server down.
	test("refuses to seed an agent whose runtime id is unknown (warren-c4be)", async () => {
		const bad = {
			name: "stub-shell",
			version: 1,
			sections: { system: "hi" },
			resolvedFrom: [],
			frontmatter: { source: "builtin", runtime: "planner" },
		};
		const result = await seedBuiltinAgents(repo, [bad]);
		expect(result.seeded).toEqual([]);
		expect(result.rejected).toHaveLength(1);
		expect(result.rejected[0]?.name).toBe("stub-shell");
		expect(result.rejected[0]?.reason).toMatch(/is not a known runtime id/);
		expect(await repo.get("stub-shell")).toBeNull();
	});

	test("seeds the good agents alongside a rejected one (boot completes)", async () => {
		const bad = {
			name: "bad-runtime",
			version: 1,
			sections: { system: "hi" },
			resolvedFrom: [],
			frontmatter: { source: "builtin", runtime: "nope" },
		};
		const result = await seedBuiltinAgents(repo, [bad, CLAUDE_CODE_BUILTIN]);
		expect(result.seeded).toEqual(["claude-code"]);
		expect(result.rejected.map((r) => r.name)).toEqual(["bad-runtime"]);
		expect(await repo.get("claude-code")).not.toBeNull();
	});

	test("accepts an operator-declared extra runtime id (warren-c4be)", async () => {
		const previous = process.env.WARREN_EXTRA_RUNTIME_IDS;
		process.env.WARREN_EXTRA_RUNTIME_IDS = "stub-shell";
		try {
			const result = await seedBuiltinAgents(repo, [
				{
					name: "stub-shell",
					version: 1,
					sections: { system: "hi" },
					resolvedFrom: [],
					frontmatter: { source: "builtin", runtime: "stub-shell" },
				},
			]);
			expect(result.rejected).toEqual([]);
			expect(result.seeded).toEqual(["stub-shell"]);
		} finally {
			if (previous === undefined) delete process.env.WARREN_EXTRA_RUNTIME_IDS;
			else process.env.WARREN_EXTRA_RUNTIME_IDS = previous;
		}
	});

	test("preserves existing rows (library override) and skips them", async () => {
		// Simulate a prior refresh having installed a canopy 'claude-code' override.
		await repo.upsert({
			name: "claude-code",
			renderedJson: { name: "claude-code", sections: { system: "library override" } },
		});
		const result = await seedBuiltinAgents(repo);
		expect(result.skipped).toContain("claude-code");
		// Library override is preserved; not overwritten by the builtin.
		const stored = await repo.get("claude-code");
		expect(stored).not.toBeNull();
		expect(readAgentSource(stored?.renderedJson)).toBe("library");
	});

	test("is idempotent — second call seeds nothing", async () => {
		await seedBuiltinAgents(repo);
		const second = await seedBuiltinAgents(repo);
		expect(second.seeded).toEqual([]);
		expect([...second.skipped].sort()).toEqual([...BUILTIN_AGENT_NAMES].sort());
	});

	test("re-upserts pre-existing builtin rows when their content/frontmatter has drifted", async () => {
		const oldPlanner = {
			...PLANNER_BUILTIN,
			frontmatter: {
				...PLANNER_BUILTIN.frontmatter,
				runtime: undefined, // Simulates pre-v0.5.1 state where runtime wasn't set
			},
		};

		await repo.upsert({
			name: "planner",
			renderedJson: oldPlanner,
		});

		// Now run seedBuiltinAgents. It should recognize the drift and re-upsert planner.
		const result = await seedBuiltinAgents(repo);
		expect(result.seeded).toContain("planner");

		// The stored version should now have the updated frontmatter with 'runtime' set to 'pi'.
		const stored = await repo.get("planner");
		expect(stored).not.toBeNull();
		const rendered = stored?.renderedJson as { frontmatter: { runtime: string } };
		expect(rendered.frontmatter.runtime).toBe("pi");
	});
});

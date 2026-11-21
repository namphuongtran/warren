// Wall-clock limit precedence at dispatch (namphuongtran/warren#10): explicit
// override (POST /runs body / `warren run --max-duration-minutes`) > agent
// frontmatter > project-wide `.warren/config.yaml` maxDurationMinutes. The
// folded value freezes onto rendered_agent_json, which the bridge reads at
// enforcement time. Mirrors dispatch.cost-cap.test.ts.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { WarrenDb } from "../../db/client.ts";
import type { Repos } from "../../db/repos/index.ts";
import { createWarrenConfigCache } from "../../warren-config/cache.ts";
import { spawnRun } from "./index.ts";
import { makeAgentJson, makeProvider, makeSandboxClient, setupRepos } from "./test-helpers.ts";

const limitConfigs = (maxDurationMinutes: number) =>
	createWarrenConfigCache({
		load: async () => ({
			triggers: null,
			defaults: { maxDurationMinutes },
			prTemplate: null,
			sourceFile: null,
			errors: [],
			warnings: [],
		}),
	});

const dispatchedFrontmatter = (
	calls: readonly { path: string; body?: unknown }[],
): Record<string, unknown> => {
	const dispatch = calls.find((c) => c.path === "/sandboxes/bur_aaaaaaaaaaaa/runs");
	const body = dispatch?.body as { metadata: { frontmatter: Record<string, unknown> } };
	return body.metadata.frontmatter;
};

describe("spawnRun: maxDurationMinutes precedence (namphuongtran/warren#10)", () => {
	let db: WarrenDb;
	let repos: Repos;

	beforeEach(async () => {
		({ db, repos } = await setupRepos());
	});
	afterEach(async () => {
		await db.close();
	});

	async function dispatchWith(input: {
		readonly frontmatter: Record<string, unknown>;
		readonly override?: number;
		readonly projectDefault?: number;
	}): Promise<Record<string, unknown>> {
		await repos.agents.upsert({
			name: "pi",
			renderedJson: makeAgentJson({ name: "pi", frontmatter: input.frontmatter }),
		});
		const { client, calls } = makeSandboxClient();
		await spawnRun({
			repos,
			runtimeProvider: makeProvider(client),
			agentName: "pi",
			projectId: "prj_xxxxxxxxxxxx",
			prompt: "p",
			...(input.override !== undefined ? { maxDurationMinutesOverride: input.override } : {}),
			...(input.projectDefault !== undefined
				? { warrenConfigs: limitConfigs(input.projectDefault) }
				: {}),
		});
		return dispatchedFrontmatter(calls);
	}

	test("applies the project-default limit when the agent declares none", async () => {
		const fm = await dispatchWith({ frontmatter: {}, projectDefault: 90 });
		expect(fm.maxDurationMinutes).toBe(90);
	});

	test("keeps the agent's own limit over the project default", async () => {
		const fm = await dispatchWith({ frontmatter: { maxDurationMinutes: 60 }, projectDefault: 90 });
		expect(fm.maxDurationMinutes).toBe(60);
	});

	test("leaves a malformed agent limit in place instead of papering over it", async () => {
		const fm = await dispatchWith({
			frontmatter: { maxDurationMinutes: "6O" },
			projectDefault: 90,
		});
		expect(fm.maxDurationMinutes).toBe("6O");
	});

	test("lets an explicit override win over the agent limit and the project default", async () => {
		const fm = await dispatchWith({
			frontmatter: { maxDurationMinutes: 60 },
			override: 15,
			projectDefault: 90,
		});
		expect(fm.maxDurationMinutes).toBe(15);
	});

	test("leaves the run unlimited when no source declares a limit", async () => {
		const fm = await dispatchWith({ frontmatter: {} });
		expect(fm.maxDurationMinutes).toBeUndefined();
	});
});

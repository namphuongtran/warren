/**
 * The preparation half of a dispatch (docs/design/agent-composition.md): load
 * the agent and project, refresh the host clone onto the base ref, and fold
 * the provider, model, cap and duration chains onto the frozen agent. No run
 * row and no runtime contact happen here, so a refusal after this point
 * (the provider-quota guard) leaves nothing behind. Split out of
 * `dispatch.ts` so a held run (namphuongtran/warren#30) can be prepared again
 * when its window reopens and launched as the same row.
 */

import { NotFoundError } from "../../core/errors.ts";
import type { ProjectRow } from "../../db/schema.ts";
import { type RefreshProjectResult, refreshProject } from "../../projects/manage.ts";
import {
	type AgentDefinition,
	readProviderFrontmatter,
	withMaxCostUsdOverride,
	withProviderOverrides,
} from "../../registry/schema.ts";
import type { DefaultsConfig } from "../../warren-config/schema.ts";
import { type ParsedBurrowConfig, parseBurrowConfig } from "../burrow-config.ts";
import { resolveCapOverride } from "../cost-cap.ts";
import { withDurationLimit } from "../duration-limit.ts";
import { buildSeedFiles, type SeedFile } from "../seed.ts";
import { validateTargetBranch } from "../target-branch.ts";
import { readCachedAgent, readProjectDefaults, resolveOverride } from "./agent-cache.ts";
import { withBranchDefaults } from "./branch-config.ts";
import { resolveContinuationRef, resolveDispatchBranches } from "./continuation.ts";
import { gateAgentPrompts, withMulchArm } from "./prompt-capabilities.ts";
import {
	assertNoKnownProviderModelMismatch,
	type DispatchProviderChoice,
	resolveDispatchProvider,
} from "./provider-model.ts";
import type { SpawnRunInput } from "./types.ts";

export interface PreparedDispatch {
	/** The clone ref frozen onto the row as `ref`. */
	readonly baseRefField: string | undefined;
	/** The branch the run pushes to instead of its composed branch. */
	readonly pushTarget: string | undefined;
	readonly newBranch: string | undefined;
	/** The ref the workspace is cut from, when not the project default branch. */
	readonly baseRef: string | undefined;
	/** Whether the host clone was refreshed (it is not without a spawn seam). */
	readonly refreshed: boolean;
	/**
	 * The clone HEAD after the refresh, which `projectDefaults` was read at
	 * (namphuongtran/warren#165). Always the default-branch tip: a run cut
	 * from another base takes only its branch-sourced keys from that base
	 * (namphuongtran/warren#169). Undefined without a refresh.
	 */
	readonly configCommit: string | undefined;
	readonly project: ProjectRow;
	readonly projectDefaults: DefaultsConfig | null;
	readonly providerChoice: DispatchProviderChoice;
	/** The cached agent before any fold, for the dispatch-context cap source. */
	readonly baseAgent: AgentDefinition;
	readonly burrowConfig: ParsedBurrowConfig;
	/** The agent with every override folded on: what the row freezes. */
	readonly agent: AgentDefinition;
	readonly declaredProvider: string | undefined;
	readonly declaredModel: string | undefined;
	/** Built before any row exists, so a malformed seed section leaves none behind. */
	readonly seedFiles: readonly SeedFile[];
}

export async function prepareDispatch(input: SpawnRunInput): Promise<PreparedDispatch> {
	const agentRow = await input.repos.agents.get(input.agentName);
	if (!agentRow) {
		throw new NotFoundError(`agent not found: ${input.agentName}`);
	}
	const project = await input.repos.projects.require(input.projectId);
	// warren-3a75: `targetBranch` is a push target the finalize step writes to
	// directly, with no PR and therefore no Article IX gate. Enforce the ref
	// grammar and refuse the project default branch BEFORE any side effect (no
	// clone refresh, no run row). Repair runs targeting an existing PR head
	// branch are unaffected.
	const targetBranch = validateTargetBranch(input.targetBranch, project.defaultBranch);
	// warren-326f: the explicit opt-in to run on an EXISTING branch. Shape-validated
	// and fail-closed against the push remote BEFORE any side effect, then folded
	// into the repair-run pattern (branch = base ref = push target); see
	// resolveDispatchBranches (#58: newBranch too). Downstream keeps reading `ref`/`targetBranch`, so
	// providers and reap need no special-casing and default dispatches are
	// byte-identical.
	const { existingBranch, newBranch } = await resolveDispatchBranches(input, project);
	const baseRefField = existingBranch ?? input.ref;
	const pushTarget = existingBranch ?? targetBranch;

	const baseAgent = readCachedAgent(agentRow.renderedJson, agentRow.name);
	const burrowConfig = parseBurrowConfig(baseAgent.sections.burrow_config);

	// warren-4b11: continuation runs ("re-run with follow-up") seed their
	// workspace from the prior run's pushed branch instead of the project
	// default branch. Resolve the parent's branch up front and hand it to the
	// refresh as the base, which brings it to origin's tip without a checkout
	// (namphuongtran/warren#169), before the provider cuts the new run branch
	// off it. The parent link is also recorded on the new run row below so the
	// UI can render a chain indicator and chain cost/token totals are
	// derivable by walking the link.
	const baseRef = input.baseCommit ?? (await resolveContinuationRef(input, project, pushTarget));

	const refreshed = await refreshDispatchClone(input, project, baseRef);
	const projectAfterRefresh = refreshed?.project ?? project;

	// warren-618b: fold per-project provider/model defaults onto the agent
	// frontmatter, operator per-run override winning. Order: operator
	// override > .warren/defaults.json > agent frontmatter, all riding the
	// same `withProviderOverrides` path onto frozen `rendered_agent_json`.
	// namphuongtran/warren#169: the clone sits on the default-branch tip, so
	// this reads every guardrail and `repoContext` from there. A run cut from
	// another base then takes its branch-sourced keys from that base.
	const projectDefaults = await withBranchDefaults(
		input,
		refreshed,
		await readProjectDefaults(
			input.warrenConfigs,
			projectAfterRefresh.id,
			projectAfterRefresh.localPath,
		),
	);
	// namphuongtran/warren#43: a model-only override drops an incompatible inherited provider.
	const providerChoice = resolveDispatchProvider(input, projectDefaults?.defaultProvider);
	const agent = composeDispatchAgent(input, {
		baseAgent,
		project: projectAfterRefresh,
		projectDefaults,
		provider: providerChoice.provider,
	});
	// warren-bad5: once the override chain resolves, validate it.
	const { provider: declaredProvider, model: declaredModel } = readProviderFrontmatter(
		agent.frontmatter,
	);
	assertNoKnownProviderModelMismatch(declaredProvider, declaredModel);

	return {
		baseRefField,
		pushTarget,
		newBranch,
		baseRef,
		refreshed: refreshed !== null,
		configCommit: refreshed?.headSha,
		project: projectAfterRefresh,
		projectDefaults,
		providerChoice,
		baseAgent,
		burrowConfig,
		agent,
		declaredProvider,
		declaredModel,
		// A malformed expertise_seed / pi_skills / pi_prompts section fails here.
		seedFiles: buildSeedFiles(agent).files,
	};
}

/**
 * Every dispatch refreshes the shared clone onto the default branch, so the
 * project defaults read next come from the default-branch tip, and so does
 * every later reader of the clone (namphuongtran/warren#165, #169). A base
 * rides alongside without a checkout. A pin rides `fetchCommit`: its objects
 * must be present, and the provider cuts the workspace at the SHA itself, so
 * the clone never detaches onto a pin (warren-232d). Any other non-default
 * base (`--ref`, existing branch, continuation parent) rides `fetchRef`: a
 * branch is brought to origin's tip as a local ref the provider cuts from.
 * `null` when the caller wired no spawn seam (no refresh happens).
 */
async function refreshDispatchClone(
	input: SpawnRunInput,
	project: ProjectRow,
	baseRef: string | undefined,
): Promise<RefreshProjectResult | null> {
	if (input.projectsConfig === undefined || input.projectSpawn === undefined) return null;
	const target =
		input.baseCommit !== undefined
			? { fetchCommit: input.baseCommit }
			: baseRef !== undefined && baseRef !== project.defaultBranch
				? { fetchRef: baseRef }
				: {};
	return (input.refreshProjectFn ?? refreshProject)({
		repo: input.repos.projects,
		config: input.projectsConfig,
		id: project.id,
		...target,
		gitCredential: input.gitCredential,
		spawn: input.projectSpawn,
		...(input.now !== undefined ? { now: input.now } : {}),
		...(input.warrenConfigs !== undefined ? { warrenConfigs: input.warrenConfigs } : {}),
	});
}

interface ComposeAgentSources {
	readonly baseAgent: AgentDefinition;
	readonly project: ProjectRow;
	readonly projectDefaults: DefaultsConfig | null;
	/** The provider `resolveDispatchProvider` chose. */
	readonly provider: string | undefined;
}

/** Fold the model, cap, duration and mulch chains onto the agent the row freezes. */
function composeDispatchAgent(input: SpawnRunInput, src: ComposeAgentSources): AgentDefinition {
	const { baseAgent, projectDefaults, provider } = src;
	const model = resolveOverride(input.modelOverride, projectDefaults?.defaultModel);
	// warren-a63d: fold the per-dispatch spend cap on top. The full chain
	// (override > agent frontmatter > project default, with malformed agent
	// values still failing open) lives in resolveCapOverride — cost-cap.ts
	// owns the semantics, this site only feeds it the three sources.
	const capOverride = resolveCapOverride({
		...(input.maxCostUsdOverride !== undefined ? { overrideUsd: input.maxCostUsdOverride } : {}),
		frontmatter: baseAgent.frontmatter,
		...(projectDefaults?.maxCostUsd !== undefined
			? { projectDefaultUsd: projectDefaults.maxCostUsd }
			: {}),
	});
	// namphuongtran/warren#10: the wall-clock limit rides the same chain (duration-limit.ts).
	const durationSources = {
		overrideMinutes: input.maxDurationMinutesOverride,
		projectDefaultMinutes: projectDefaults?.maxDurationMinutes,
	};
	// warren-cb46: gate tracker/mulch prompt fragments on the project's real
	// capabilities before anything freezes the agent (prompt-capabilities.ts).
	return gateAgentPrompts(
		withMulchArm(
			withMaxCostUsdOverride(
				withProviderOverrides(withDurationLimit(baseAgent, durationSources), {
					...(provider !== undefined ? { providerOverride: provider } : {}),
					...(model !== undefined ? { modelOverride: model } : {}),
				}),
				capOverride,
			),
			input.mulchArm,
		),
		src.project,
		input.issueTracker,
	);
}

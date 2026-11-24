/**
 * `spawnRun` — composition flow (docs/design/agent-composition.md). Resolves the cached
 * agent, builds a neutral `RunSpec`, and dispatches via `provider.create(spec)`
 * (warren-c42c). The run row is created BEFORE `create`; `attachBurrow` writes
 * correlation ids only after success. A failed `create` rolls the row back
 * `failed`/`never_started`. Dispatch-context (warren-d6ca) snapshots right after.
 */

import { ValidationError } from "../../core/errors.ts";
import { resolveRunCostBasis } from "../../core/providers.ts";
import type { QuotaHoldView } from "../../core/wire.ts";
import type { RunRow } from "../../db/schema.ts";
import { withProjectCloneLock } from "../../projects/clone-lock.ts";
import { readRuntimeId } from "../../registry/schema.ts";
import type { RunHandle, RunSpec, RuntimeProvider } from "../../runtime/contract.ts";
import { interactiveRuntimeOverride } from "../../warren-config/schema.ts";
import { composeRunBranch, resolveRunBranchPrefix } from "../branch.ts";
import { lifecycleBus } from "../lifecycle-bus.ts";
import { QUALITY_GATE_ENV_VAR } from "../quality-gate/command.ts";
import { heldDispatchRequest, recordQuotaHold, requireHeldRunPending } from "../quota/hold.ts";
import { ProviderQuotaExhaustedError } from "../quota/state.ts";
import { injectWarrenCallbackEnv } from "./callback-env.ts";
import { writeDispatchContext } from "./dispatch-context.ts";
import { injectGitIdentityEnv, warnIfGitIdentityUnconfigured } from "./git-identity.ts";
import {
	appendMigrationCollisionNote,
	detectMigrationJournalCollisions,
	runDispatchMigrationPreflight,
} from "./migration-preflight.ts";
import { recordModelSelectionWarnings } from "./model-selection.ts";
import { type PreparedDispatch, prepareDispatch } from "./prepare.ts";
import { assertDispatchQuotaOpen } from "./quota-guard.ts";
import {
	bindRunLogger,
	compensateCreatedRuntime,
	logDispatched,
	logPlacement,
	logProvisioned,
	logSpawnFailed,
	rollback,
} from "./rollback.ts";
import { resolveSeedTracker, writeSeedExtensions } from "./seed-extensions.ts";
import type { SpawnRunInput, SpawnRunResult } from "./types.ts";

/**
 * Vestigial worker-placement label on the `spawn.placement` /
 * `spawn.provisioned` log lines (warren-c42c). Multi-worker placement was
 * retired with the K8s migration (warren-76c5 / warren-3743), so this is a
 * fixed log field, not a routing decision.
 */
const WORKER_PLACEMENT_LABEL = "local";

export async function spawnRun(input: SpawnRunInput): Promise<SpawnRunResult> {
	assertPromptPresent(input);
	// warren-232d: serialize the per-project dispatch critical section — the
	// clone refresh (`checkout --force` / `reset --hard`), the working-tree
	// defaults read, and the provider's worktree materialization all mutate or
	// read the SAME shared host clone, so two concurrent dispatches on one
	// project with different base refs must not interleave. Different projects
	// dispatch in parallel; see src/projects/clone-lock.ts.
	return withProjectCloneLock(input.projectId, async () => {
		const prepared = await prepareDispatch(input);
		// namphuongtran/warren#30: refuse a spent quota once the provider is known.
		await assertDispatchQuotaOpen(input, prepared);
		return launchRun(input, prepared, await createRunRow(input, prepared));
	});
}

export type SpawnOrHoldResult =
	| { readonly kind: "dispatched"; readonly result: SpawnRunResult }
	| { readonly kind: "held"; readonly run: RunRow; readonly hold: QuotaHoldView };

/**
 * `spawnRun`, except that a dispatch the provider-quota guard refuses becomes
 * a held run (namphuongtran/warren#30): the row is created `queued` with no
 * workload, and a `dispatch.quota_held` event records the request and when
 * the quota hold releaser launches it.
 */
export async function spawnOrHoldRun(input: SpawnRunInput): Promise<SpawnOrHoldResult> {
	assertPromptPresent(input);
	return withProjectCloneLock(input.projectId, async () => {
		const prepared = await prepareDispatch(input);
		try {
			await assertDispatchQuotaOpen(input, prepared);
		} catch (err) {
			if (!(err instanceof ProviderQuotaExhaustedError)) throw err;
			const run = await createRunRow(input, prepared);
			const hold = await recordQuotaHold(input.repos, {
				runId: run.id,
				request: heldDispatchRequest(input),
				resetsAt: err.resetsAt,
				now: input.now?.() ?? new Date(),
			});
			bindRunLogger(input.logger, run.id, {}).info(
				{ event: "spawn.quota_held", ...hold },
				"spawn: held until the provider quota window resets",
			);
			return { kind: "held", run, hold };
		}
		const result = await launchRun(input, prepared, await createRunRow(input, prepared));
		return { kind: "dispatched", result };
	});
}

/**
 * Launch a held run as the same row once its window reopens
 * (namphuongtran/warren#30). `input` is the held request replayed. A guard
 * that still refuses throws {@link ProviderQuotaExhaustedError} and leaves
 * the row held. Any other failure before the launch fails the row
 * `never_started`, the same as a failed spawn.
 */
export async function launchHeldRun(
	input: SpawnRunInput,
	heldRunId: string,
): Promise<SpawnRunResult> {
	return withProjectCloneLock(input.projectId, async () => {
		await requireHeldRunPending(input.repos, heldRunId);
		let prepared: PreparedDispatch;
		try {
			prepared = await prepareDispatch(input);
			await assertDispatchQuotaOpen(input, prepared);
		} catch (err) {
			if (!(err instanceof ProviderQuotaExhaustedError)) {
				await rollback(input, heldRunId, bindRunLogger(input.logger, heldRunId, {}), err);
			}
			throw err;
		}
		return launchRun(input, prepared, await requireHeldRunPending(input.repos, heldRunId));
	});
}

function assertPromptPresent(input: SpawnRunInput): void {
	if (input.prompt.trim() === "") {
		throw new ValidationError("prompt cannot be empty");
	}
}

async function createRunRow(input: SpawnRunInput, prepared: PreparedDispatch): Promise<RunRow> {
	const { agent, declaredProvider, declaredModel, projectDefaults, pushTarget } = prepared;
	const { baseAgent, baseRefField, project: projectAfterRefresh } = prepared;
	// warren-2ede / pl-103e: freeze the DECLARED provider/model onto real
	// columns so analytics group-bys read the columns instead of re-parsing
	// rendered_agent_json per query. This is the resolved frontmatter value
	// (override chain already folded in above), not what the harness used.
	const run = await input.repos.runs.create({
		agentName: agent.name,
		projectId: projectAfterRefresh.id,
		prompt: input.prompt,
		renderedAgentJson: agent,
		...(declaredProvider !== undefined ? { provider: declaredProvider } : {}),
		...(declaredModel !== undefined ? { model: declaredModel } : {}),
		// warren-f3c3: freeze how the run's cost will be priced. A run whose
		// anthropic credential is CLAUDE_CODE_OAUTH_TOKEN (subscription auth)
		// gets `subscription_estimate` so costUsd reads as an estimate, not a
		// bill. Resolved beside the provider env registry (core/providers.ts).
		costBasis: resolveRunCostBasis(declaredProvider, input.serverEnv ?? process.env),
		qualityGate: projectDefaults?.qualityGate ?? null, // namphuongtran/warren#36
		trigger: input.trigger ?? "manual",
		...(input.seedId !== undefined ? { seedId: input.seedId } : {}),
		...(input.mode !== undefined ? { mode: input.mode } : {}),
		...(input.parentRunId !== undefined && input.parentRunId !== ""
			? { parentRunId: input.parentRunId, cloneKind: input.cloneKind ?? "continue" }
			: {}),
		...(input.retryOf !== undefined && input.retryOf !== "" ? { retryOf: input.retryOf } : {}),
		...(pushTarget !== undefined ? { targetBranch: pushTarget } : {}),
		// warren-afeb: freeze the explicit dispatch-supplied clone ref onto the
		// row so POST /runs and GET /runs/:id can echo that it took.
		...(baseRefField !== undefined ? { ref: baseRefField } : {}),
		// warren-aaf7: freeze the base-commit pin so the projections can echo
		// it; the PR base resolution (reap) reads `ref` only, never this.
		...(input.baseCommit !== undefined ? { baseCommit: input.baseCommit } : {}),
		now: input.now?.(),
	});
	// warren-a0a2: expose the run id the instant the row exists so the cron
	// bounded-retry GC can reclaim it if the dispatch below throws (see types).
	input.onRunRowCreated?.(run.id);

	// warren-d6ca: dispatch-context snapshot BEFORE any runtime contact so a
	// never-started failure still gets a row. Fire-and-log — see writeDispatchContext.
	await writeDispatchContext({
		spawn: input,
		run,
		agent,
		baseAgent,
		declaredProvider,
		declaredModel,
		projectDefaults,
		network: prepared.burrowConfig.network ?? "none",
	});
	return run;
}

/** The runtime half of a dispatch: compose the spec, create the workload, attach it. */
async function launchRun(
	input: SpawnRunInput,
	prepared: PreparedDispatch,
	run: RunRow,
): Promise<SpawnRunResult> {
	const { agent, projectDefaults, pushTarget, newBranch, baseRef, burrowConfig } = prepared;
	const projectAfterRefresh = prepared.project;
	// warren-76c5 / warren-3743: multi-worker placement is retired; the label is a fixed log field.
	logPlacement(input.logger, WORKER_PLACEMENT_LABEL, projectAfterRefresh.id);

	// warren-9993/a993: burrow branch = `${prefix}/${run.id}` (prefix precedence
	// project default > env > built-in "warren" default); a CI-fixer run's `targetBranch` pins it
	// to the open PR head ref instead, so the fixer's commits re-run that PR's CI.
	const branch = composeRunBranch(
		resolveRunBranchPrefix({
			projectDefault: projectDefaults?.runBranchPrefix,
			envDefault: input.runBranchPrefixDefault,
		}),
		run.id,
		pushTarget ?? newBranch,
	);

	const runEnv = composeRunEnv(run.id, projectDefaults?.qualityGate, input.serverEnv);

	// warren-b802: per-project runtime override (planner stays 'builtin').
	const runtimeOverride = interactiveRuntimeOverride(agent.name, projectDefaults);
	const runtimeId = readRuntimeId(agent, runtimeOverride);

	// warren-9ce3: read dispatcherHandle + dispatchOrigin (were dropped silently).
	const log = bindRunLogger(input.logger, run.id, {
		dispatcherHandle: input.dispatcherHandle,
		dispatchOrigin: input.dispatchOrigin,
	});
	// warren-e7b7: warn once per dispatch when agent git identity is unset (K8s).
	warnIfGitIdentityUnconfigured(log, input.serverEnv ?? process.env);
	// namphuongtran/warren#7 / #43: warn about a dropped provider/model.
	const selection = {
		...prepared.providerChoice,
		provider: prepared.declaredProvider,
		model: prepared.declaredModel,
	};
	await recordModelSelectionWarnings(input, { runId: run.id, runtimeId, selection, log });
	// Runtime-provider seam (warren-c42c: burrow-client eviction, bucket 2).
	// `provider.create` collapses burrow's provision + dispatch (`sandboxUp` +
	// `runs.create`) into one call and owns the sandbox-half rollback on a partial
	// failure (best-effort destroy + rethrow). The spawn path is now EXCLUSIVELY
	// the provider path — no burrow-direct fallback. Callers resolve the
	// boot-selected provider (`resolveRuntimeProvider`, honoring `WARREN_RUNTIME`)
	// and thread it in; there is no `sandboxClient` on this seam to fall back to.
	const provider: RuntimeProvider = input.runtimeProvider;
	// Neutral RunSpec (provider maps it to the two burrow calls). `network` is
	// REQUIRED on the seam, so resolve burrow's own default (`none`) here — the
	// domain now owns the "no explicit network ⇒ default" decision that
	// `provisionBurrow` used to defer to burrow by omitting the key. `baseBranch`
	// is carried for the seam contract (K8s init container needs it); the
	// LocalProvider IGNORES it, byte-faithful to today's dispatch which never
	// sent it. `hostClonePathHint` is ALWAYS the host clone projectRoot.
	const spec: RunSpec = {
		runId: run.id,
		originUrl: projectAfterRefresh.gitUrl,
		branch,
		// warren-dac8: the RESOLVED base ref (explicit ref / targetBranch /
		// continuation parent branch), not blindly the project default branch.
		// The K8s init container cuts the workspace off `baseBranch`; a
		// ref-dispatch cut from the default branch misses the target ref's
		// tip and finalize's push reaps non-fast-forward (finalize_failed).
		baseBranch: baseRef ?? projectAfterRefresh.defaultBranch,
		hostClonePathHint: projectAfterRefresh.localPath,
		// warren-b6f2: project identity + per-project concurrency cap for K8s
		// admission control (design §3.3). The provider stamps the project label
		// and gates on the cap; LocalProvider ignores both.
		projectId: projectAfterRefresh.id,
		...(projectDefaults?.admission?.maxConcurrentRuns !== undefined
			? { maxProjectConcurrency: projectDefaults.admission.maxConcurrentRuns }
			: {}),
		// warren-aedd: carry the project's `.warren/config.yaml` `resources` block
		// (pod requests/limits/network defaults) onto the neutral RunSpec so the
		// K8sProvider's pod-spec resolution can fold it in. LocalProvider ignores it.
		...(projectDefaults?.resources !== undefined
			? { projectResources: projectDefaults.resources }
			: {}),
		// warren-fabb: per-project agent image override (docker + k8s consume it;
		// LocalProvider ignores it — host toolchain). Precedence: project override
		// > WARREN_DOCKER_AGENT_IMAGE / WARREN_K8S_AGENT_IMAGE env > default.
		...(projectDefaults?.agentImage !== undefined
			? { agentImage: projectDefaults.agentImage }
			: {}),
		runtimeId,
		prompt: composeDispatchPrompt(
			agent.sections.system,
			input.prompt,
			projectDefaults?.repoContext,
		),
		metadata: composeBurrowMetadata(input.metadata, agent.frontmatter),
		mode: input.mode ?? "batch",
		network: burrowConfig.network ?? "none",
		seedFiles: prepared.seedFiles,
		env: runEnv,
	};
	// warren-c2c8: the handle `create` returned, kept so a failure AFTER a
	// successful create can tear down the live workload it names.
	let created: RunHandle | undefined;
	try {
		// warren-5255: freeze the composed workspace branch onto the row so
		// HTTP consumers (the campaign-controller's cross-fork head ref) read
		// it instead of re-deriving the prefix composition. Inside the try so
		// a failure unwinds through the same rollback as the dispatch itself.
		await input.repos.runs.setBranch(run.id, branch);
		// warren-1f03 / warren-4371: drizzle migration journal preflight for a
		// ref-dispatch onto an existing branch (a fresh dispatch from the default
		// branch cannot collide). DETECTION ONLY on the host: a collision becomes
		// an agent prompt note plus a system event, and the run regenerates the
		// migrations inside its own sandbox. No repository-defined script runs in
		// the control plane. warren-232d: a baseCommit dispatch skips it — its
		// host clone was never checked out onto the pinned base.
		const collisionNote =
			prepared.refreshed &&
			input.baseCommit === undefined &&
			baseRef !== undefined &&
			baseRef !== projectAfterRefresh.defaultBranch &&
			input.projectSpawn !== undefined
				? await runDispatchMigrationPreflight({
						detect: input.migrationPreflightFn ?? detectMigrationJournalCollisions,
						input: {
							spawn: input.projectSpawn,
							projectPath: projectAfterRefresh.localPath,
							defaultBranch: projectAfterRefresh.defaultBranch,
							baseRef,
							...(input.projectsConfig?.gitBinary !== undefined
								? { gitBinary: input.projectsConfig.gitBinary }
								: {}),
						},
						regenerateCommand: projectDefaults?.migrations?.regenerateCommand,
						repos: input.repos,
						runId: run.id,
						now: input.now?.() ?? new Date(),
						logInfo: (obj, msg) => log.info(obj, msg),
					})
				: null;
		spec.prompt = appendMigrationCollisionNote(spec.prompt, collisionNote);
		const dispatchStart = Date.now();
		const handle = await provider.create(spec);
		created = handle;
		logProvisioned(log, handle.sandboxId, WORKER_PLACEMENT_LABEL, dispatchStart);
		// warren-3743: the provider owns partial-failure cleanup, so the burrow
		// correlation ids are written back onto the run only after `create` fully
		// succeeds. These ids are load-bearing for LocalProvider resume across a
		// host restart. warren-c2c8: one write, so the row never holds half a pair.
		const updated = await input.repos.runs.attachBurrow(run.id, {
			sandboxId: handle.sandboxId,
			sandboxRunId: handle.providerRunId,
		});
		logDispatched(log, handle.sandboxId, handle.providerRunId, dispatchStart);
		// warren-4e74: fire the observe-only `run_dispatched` lifecycle hook.
		// A no-op when no bus is installed (unit tests) or no extension
		// subscribes; a subscriber can neither mutate this payload nor stall
		// the dispatch (Tier-1 observe, warren-ext/v1).
		lifecycleBus()?.emitRunDispatched({
			runId: run.id,
			projectId: projectAfterRefresh.id,
			agentName: agent.name,
			branch,
			trigger: input.trigger ?? "manual",
			sandboxId: handle.sandboxId,
			providerRunId: handle.providerRunId,
		});
		// pl-bb70 step 4 + warren-6234: stamp the run's tracker metadata
		// after dispatch via the IssueTracker seam, fire-and-log (see
		// seed-extensions.ts). A legacy `seedsCli` (plan-runs port pending,
		// warren-2d98) wraps in SeedsTracker here.
		const seedTracker = resolveSeedTracker(input.issueTracker, input.seedsCli);
		if (input.seedId !== undefined && seedTracker !== undefined) {
			await writeSeedExtensions({
				repos: input.repos,
				issueTracker: seedTracker,
				projectId: projectAfterRefresh.id,
				projectPath: projectAfterRefresh.localPath,
				seedId: input.seedId,
				runId: run.id,
				agentName: agent.name,
				trigger: input.trigger,
				now: input.now?.() ?? new Date(),
				logger: log,
			});
		}
		// `workspacePath` is a burrow host path with no provider-neutral home, so
		// the seam's `RunHandle` drops it (design §: the domain must never leak a
		// host path). It survives as a display-only field on the HTTP response +
		// UI, slated for removal with the multi-worker/`/sandboxes` surface (plan
		// §5.C); no value is available across the seam, so it is empty here.
		return {
			run: updated,
			sandbox: { id: handle.sandboxId, workspacePath: "" },
			sandboxRun: { id: handle.providerRunId },
			agent,
		};
	} catch (err) {
		logSpawnFailed(log, created?.sandboxId ?? null, err);
		// A failed create() already destroyed its partial provision. A failure
		// after a successful create (warren-c2c8) leaves a live workload only
		// the domain knows about, so compensate it before the row unwind.
		if (created !== undefined) await compensateCreatedRuntime(provider, created, log);
		await rollback(input, run.id, log, err, created?.sandboxId);
		throw err;
	}
}

// warren-b893: route Bun cache outside the workspace so `git add .` never sweeps it.
const BUN_INSTALL_CACHE_DIR = "/tmp/bun-install-cache";
/** Merge quality-gate (warren-5797) and Bun cache relocation
 * (warren-b893) into the sandbox env. Always returns a non-empty object. */
function composeRunEnv(
	runId: string,
	qualityGate: string | undefined,
	serverEnv?: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
	const env: Record<string, string> = { BUN_INSTALL_CACHE_DIR };
	if (qualityGate !== undefined) env[QUALITY_GATE_ENV_VAR] = qualityGate;
	// warren-57fd: inject a per-run SCOPED callback token (valid only for this
	// run's own inbox + finalize surface), not the operator bearer. See
	// callback-env.ts + run-token.ts for the trust-boundary rationale.
	injectWarrenCallbackEnv(env, serverEnv ?? process.env, runId);
	injectGitIdentityEnv(env, serverEnv ?? process.env);
	return env;
}

/**
 * Prefix the user's run prompt with the agent's `system` section so the
 * canopy-defined operating contract (workspace map, rituals, expectations)
 * actually reaches claude. Burrow's claude-code runtime feeds the dispatch
 * prompt to the agent as a single user turn — it never reads
 * `.warren/agent.json` itself, so without this prepend the canopy `system`
 * body is dead text on disk.
 *
 * `runs.prompt` (warren-side) keeps the user-typed input verbatim; only
 * the body sent on POST /sandboxes/:id/runs is composed.
 */
export function composeDispatchPrompt(
	systemBody: string | undefined,
	userPrompt: string,
	repoContext?: string,
): string {
	const trimmed = (systemBody ?? "").trim();
	// warren-540f: the project's `.warren/config.yaml` `repoContext` block
	// rides between the system section and the user prompt, clearly
	// delimited. Absent/whitespace-only → byte-identical to the pre-540f
	// composition.
	const context = (repoContext ?? "").trim();
	const parts = [trimmed, context].filter((part) => part !== "");
	if (parts.length === 0) return userPrompt;
	return `${parts.join("\n\n---\n\n")}\n\n---\n\n${userPrompt}`;
}

/** Fold agent frontmatter onto operator metadata (burrow-b5b4 / warren-618b). */
function composeBurrowMetadata(
	operatorMetadata: unknown,
	frontmatter: Record<string, unknown>,
): Record<string, unknown> {
	const base =
		typeof operatorMetadata === "object" && operatorMetadata !== null
			? (operatorMetadata as Record<string, unknown>)
			: {};
	return { ...base, frontmatter };
}

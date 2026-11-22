/**
 * Bridge-boot + automatic-retry wiring (warren-339d, namphuongtran/warren#30).
 *
 * `main/index.ts` boots the run-stream bridge registry, logs the
 * resume/skip summary, and then registers the run-level provider-error
 * retry on the lifecycle bus. The retry consumer can only register HERE
 * — after the bridge boot — because its redispatch needs both the
 * runtime provider and the bridge registry (`src/runs/retry/
 * provider-retry.ts`). Grouping the three steps keeps `main/index.ts`
 * under the file-size budget while preserving the boot order: bridges
 * first (so in-flight runs resume before anything new dispatches), then
 * the observer.
 */

import type { Repos } from "../../db/repos/index.ts";
import type { Forge } from "../../forge/contract.ts";
import type { SpawnFn } from "../../projects/clone.ts";
import type { ProjectsConfig } from "../../projects/config.ts";
import type { RunEventBroker } from "../../runs/events.ts";
import { reapRun } from "../../runs/index.ts";
import type { LifecycleBus } from "../../runs/lifecycle-bus.ts";
import type { RuntimeProvider } from "../../runtime/contract.ts";
import type { SeedsCliDeps } from "../../seeds-cli/index.ts";
import type { IssueTracker } from "../../tracker/contract.ts";
import type { WarrenConfigCache } from "../../warren-config/index.ts";
import { type BootBridgesResult, bootBridges, type CreateBridgeRegistryInput } from "../bridges.ts";
import type { Logger } from "../types.ts";
import { wireProviderRetry } from "./provider-retry-wiring.ts";
import { wireQuotaResume } from "./quota-resume-wiring.ts";

/** Input bag for {@link bindReapWithBootDeps}. */
export interface ReapBindingDeps {
	readonly forge: Forge;
	readonly previewSidecars: Parameters<typeof reapRun>[0]["previewSidecars"];
	readonly salvageDir: string;
	/** warren-4af7: infra-lost terminalization earns one automatic retry. */
	readonly onInfraLostRun?: Parameters<typeof reapRun>[0]["onInfraLostRun"];
}

/**
 * The boot-bound reap seam (warren-45e6): the boot-resolved forge drives
 * reap's PR sub-steps, the provider-derived preview seam + salvage dir
 * ride every call. Extracted from `main/index.ts` (warren-339d, file-size
 * budget) — the binding itself is unchanged.
 */
export function bindReapWithBootDeps(
	deps: ReapBindingDeps,
): (i: Parameters<typeof reapRun>[0]) => ReturnType<typeof reapRun> {
	return (i) =>
		reapRun({
			...i,
			forge: deps.forge,
			...(deps.previewSidecars !== undefined ? { previewSidecars: deps.previewSidecars } : {}),
			salvageDir: deps.salvageDir,
			...(deps.onInfraLostRun !== undefined ? { onInfraLostRun: deps.onInfraLostRun } : {}),
		});
}

export interface BridgesWiringInput {
	/** The bridge-registry boot input, passed through to `bootBridges` unchanged. */
	readonly bridges: CreateBridgeRegistryInput;
	readonly logger: Logger;
	/** The installed lifecycle bus the provider-retry consumer registers on. */
	readonly bus: LifecycleBus;
	readonly repos: Repos;
	readonly runtimeProvider: RuntimeProvider;
	readonly projectsConfig: ProjectsConfig;
	readonly projectSpawn: SpawnFn;
	readonly forge: Forge;
	readonly warrenConfigs: WarrenConfigCache;
	readonly seedsCli: SeedsCliDeps;
	/** Boot-resolved IssueTracker (warren-5819) — forwarded to the provider-retry consumer. */
	readonly issueTracker?: IssueTracker;
	readonly broker?: RunEventBroker;
	readonly runBranchPrefixDefault?: string;
	readonly now?: () => Date;
}

/** The automatic-retry consumers started after the bridge boot. */
export interface RetryWorkersHandle {
	/** Detach both consumers and wait for a quota-resume tick in flight (server `stop()`). */
	stop(): Promise<void>;
}

export interface BridgesWiringResult {
	readonly bridgesBoot: BootBridgesResult;
	/** The provider-retry consumer and the quota auto-resume (namphuongtran/warren#30). */
	readonly retryWorkers: RetryWorkersHandle;
}

/**
 * Boot the bridge registry, log the resume/skip summary, and start the
 * automatic-retry consumers (provider retry, quota auto-resume). Returns the
 * bridge boot result (the registry + resume bookkeeping) and their handle.
 */
export async function bootBridgesAndRetries(
	input: BridgesWiringInput,
): Promise<BridgesWiringResult> {
	const bridgesBoot = await bootBridges(input.bridges);
	if (bridgesBoot.resumed.length > 0) {
		input.logger.info(
			{ count: bridgesBoot.resumed.length },
			"resumed run-stream bridges from active runs",
		);
	}
	if (bridgesBoot.skipped.length > 0) {
		input.logger.warn(
			{ count: bridgesBoot.skipped.length, runs: bridgesBoot.skipped },
			"skipped runs without sandbox_run_id",
		);
	}

	const providerRetryRegistration = wireProviderRetry({
		bus: input.bus,
		logger: input.logger,
		repos: input.repos,
		runtimeProvider: input.runtimeProvider,
		bridges: bridgesBoot.registry,
		projectsConfig: input.projectsConfig,
		projectSpawn: input.projectSpawn,
		forge: input.forge,
		warrenConfigs: input.warrenConfigs,
		seedsCli: input.seedsCli,
		...(input.issueTracker !== undefined ? { issueTracker: input.issueTracker } : {}),
		...(input.broker !== undefined ? { broker: input.broker } : {}),
		...(input.runBranchPrefixDefault !== undefined
			? { runBranchPrefixDefault: input.runBranchPrefixDefault }
			: {}),
		...(input.now !== undefined ? { now: input.now } : {}),
	});

	const quotaResume = wireQuotaResume({ ...input, bridges: bridgesBoot.registry });
	const retryWorkers: RetryWorkersHandle = {
		async stop() {
			providerRetryRegistration.unregister();
			await quotaResume.stop();
		},
	};
	return { bridgesBoot, retryWorkers };
}

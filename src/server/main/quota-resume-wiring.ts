/**
 * Quota auto-resume wiring (namphuongtran/warren#30 Phase 2).
 *
 * The `post_reap` consumer records each `quota_exhausted` run's resume, and
 * the worker dispatches the due ones (`src/runs/retry/quota-resume.ts`). Both
 * need the bridge registry, so `bootBridgesAndRetries` calls this after the
 * bridge boot, beside the provider-retry registration.
 */

import type { Repos } from "../../db/repos/index.ts";
import type { Forge } from "../../forge/contract.ts";
import type { SpawnFn } from "../../projects/clone.ts";
import type { ProjectsConfig } from "../../projects/config.ts";
import type { RunEventBroker } from "../../runs/events.ts";
import {
	createQuotaResumeLifecycleExtension,
	createQuotaResumer,
	startQuotaResumeWorker,
} from "../../runs/index.ts";
import type { LifecycleBus } from "../../runs/lifecycle-bus.ts";
import type { SpawnLogger } from "../../runs/spawn/types.ts";
import type { BridgeRegistry } from "../../runs/stream/types.ts";
import type { RuntimeProvider } from "../../runtime/contract.ts";
import type { SeedsCliDeps } from "../../seeds-cli/index.ts";
import type { IssueTracker } from "../../tracker/contract.ts";
import type { WarrenConfigCache } from "../../warren-config/index.ts";
import type { Logger } from "../types.ts";

export interface QuotaResumeWiringInput {
	readonly bus: LifecycleBus;
	readonly logger: Logger;
	readonly repos: Repos;
	readonly runtimeProvider: RuntimeProvider;
	readonly bridges: BridgeRegistry;
	readonly projectsConfig: ProjectsConfig;
	readonly projectSpawn: SpawnFn;
	readonly forge: Forge;
	readonly warrenConfigs: WarrenConfigCache;
	readonly seedsCli: SeedsCliDeps;
	readonly issueTracker?: IssueTracker;
	readonly broker?: RunEventBroker;
	readonly runBranchPrefixDefault?: string;
	readonly now?: () => Date;
}

export interface QuotaResumeWiring {
	/** Detach the consumer and wait for a tick in flight. */
	stop(): Promise<void>;
}

export function wireQuotaResume(input: QuotaResumeWiringInput): QuotaResumeWiring {
	const { logger } = input;
	const resumeLogger: SpawnLogger = {
		info: (obj, msg) => logger.info(obj, msg),
		warn: (obj, msg) => logger.warn(obj, msg),
		error: (obj, msg) => logger.error(obj, msg),
	};
	const resumer = createQuotaResumer({
		repos: input.repos,
		runtimeProvider: input.runtimeProvider,
		bridges: input.bridges,
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
		logger: resumeLogger,
	});
	const registration = input.bus.register(createQuotaResumeLifecycleExtension(resumer));
	const worker = startQuotaResumeWorker({ resumer, logger: resumeLogger });
	return {
		async stop() {
			registration.unregister();
			await worker.stop();
		},
	};
}

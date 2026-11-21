/**
 * The `tick` command (warren-d050): one deterministic, bounded, restart-safe
 * dry-run reconciliation pass over one campaign.
 *
 * Configuration is explicit: DB path, repository-policy snapshot, summaries
 * file, and the Warren base URL come from flags or their named environment
 * variables; the Warren credential comes only from `WARREN_API_TOKEN` and
 * the optional GitHub credential only from `GITHUB_TOKEN`. There is no live
 * flag: `--live` is refused as a usage error. A GitHub write happens only
 * when the approved policy file itself enables it (`createPullRequest`, or a
 * `review` block for namphuongtran/warren#18) and a credential is present.
 */
import type { Clock, IdGenerator } from "../../clock.ts";
import { ConfigError } from "../../errors.ts";
import { ReadOnlyGithubClient } from "../../github/client.ts";
import type { FetchLike as GithubFetchLike } from "../../github/http-transport.ts";
import { BunFetchGithubTransport } from "../../github/http-transport.ts";
import { BunFetchGithubPrCreator } from "../../github/pr-create.ts";
import { BunFetchGithubReviewPublisher } from "../../github/review-publish.ts";
import { validateBotGrammar } from "../../reconcile/bot-grammar.ts";
import { type RepositoryPolicy, validateRepositoryPolicy } from "../../repository-policy.ts";
import { runTick } from "../../tick/tick.ts";
import type { FetchLike } from "../../warren-client.ts";
import { WarrenClient } from "../../warren-client.ts";
import {
	type CliConfig,
	ENV_POLICY_PATH,
	ENV_WARREN_API_TOKEN,
	ENV_WARREN_BASE_URL,
	requirePath,
} from "../config.ts";
import { CliError } from "../exit-codes.ts";
import { loadSummaries, openStore, readJsonFile } from "./shared.ts";

export interface TickCommandDeps {
	readonly clock: Clock;
	readonly ids: IdGenerator;
	/** Injectable warren fetch; production default is the global fetch. */
	readonly warrenFetch?: FetchLike;
	/** Injectable GitHub fetch; production default is the global fetch. */
	readonly githubFetch?: GithubFetchLike;
}

export async function runTickCommand(
	config: CliConfig,
	deps: TickCommandDeps,
	flags: Readonly<Record<string, string | true>>,
): Promise<Record<string, unknown>> {
	const campaignId = requireCampaignFlag(flags);
	if (config.warrenToken === null || config.warrenToken.length === 0) {
		throw new ConfigError(
			`missing warren credential: set ${ENV_WARREN_API_TOKEN} (the token enters only through that environment variable and is never echoed)`,
		);
	}
	if (config.warrenBaseUrl === null || config.warrenBaseUrl.length === 0) {
		throw new ConfigError(
			`missing warren base URL: pass --warren-url or set ${ENV_WARREN_BASE_URL}`,
		);
	}
	const policyPath = requirePath(config, "policyPath", "policy", ENV_POLICY_PATH);
	const policy = readJsonFile(policyPath, "repository policy");
	// The bot grammar is optional but fail-loud when configured (warren-8c83):
	// a bad path or an invalid grammar aborts the tick at startup instead of
	// silently disabling review-feedback classification.
	const botGrammar =
		config.botGrammarPath !== null && config.botGrammarPath.length > 0
			? validateBotGrammar(readJsonFile(config.botGrammarPath, "bot grammar"))
			: undefined;
	const summaries = loadSummaries(config.summariesPath);

	const store = openStore(config, deps.clock, deps.ids);
	try {
		const warrenClient = new WarrenClient({
			baseUrl: config.warrenBaseUrl,
			token: config.warrenToken,
			fetchFn: deps.warrenFetch,
			clock: deps.clock,
		});
		const transport = new BunFetchGithubTransport({
			baseUrl: config.githubBaseUrl ?? undefined,
			token: config.githubToken ?? undefined,
			fetchImpl: deps.githubFetch,
		});
		const github = new ReadOnlyGithubClient(transport);
		const writerPolicy = credentialedPolicy(config, deps, policy);
		const prCreator = maybeBuildPrCreator(config, deps, writerPolicy);
		const reviewPublisher = maybeBuildReviewPublisher(config, deps, writerPolicy);
		const result = await runTick(
			{
				store,
				warrenClient,
				github,
				clock: deps.clock,
				ids: deps.ids,
				policy,
				summaries,
				...(botGrammar !== undefined ? { botGrammar } : {}),
				...(prCreator !== undefined ? { prCreator } : {}),
				...(reviewPublisher !== undefined ? { reviewPublisher } : {}),
			},
			campaignId,
		);
		return result as unknown as Record<string, unknown>;
	} finally {
		store.close();
	}
}

/**
 * The validated policy, when a GitHub credential exists to act on it. Every
 * policy-gated writer starts here: no credential or an invalid policy means
 * no writer at all (an invalid policy then fails the tick at admission with
 * its own precise error).
 */
function credentialedPolicy(
	config: CliConfig,
	deps: TickCommandDeps,
	policy: unknown,
): RepositoryPolicy | undefined {
	if (config.githubToken === null || config.githubToken.length === 0) {
		return undefined;
	}
	try {
		return validateRepositoryPolicy(policy, { nowMs: deps.clock.nowMs() }).policy;
	} catch {
		return undefined;
	}
}

/**
 * The Phase 2 gate (warren-84da): the PR creator exists ONLY when the
 * validated repository policy enables `mutations.createPullRequest` AND a
 * GitHub credential is present. There is deliberately no flag for this —
 * the capability comes from the approved policy file, and `--live` stays a
 * usage error.
 */
function maybeBuildPrCreator(
	config: CliConfig,
	deps: TickCommandDeps,
	policy: RepositoryPolicy | undefined,
): BunFetchGithubPrCreator | undefined {
	if (policy === undefined || policy.mutations.createPullRequest !== true) {
		return undefined;
	}
	return new BunFetchGithubPrCreator({
		policy,
		baseUrl: config.githubBaseUrl ?? undefined,
		token: config.githubToken ?? "",
		fetchImpl: deps.githubFetch,
	});
}

/**
 * The namphuongtran/warren#18 gate: the review publisher exists ONLY when the validated policy
 * carries a `review` block AND a GitHub credential is present. Absent block
 * means the review stage never runs, off and silent.
 */
function maybeBuildReviewPublisher(
	config: CliConfig,
	deps: TickCommandDeps,
	policy: RepositoryPolicy | undefined,
): BunFetchGithubReviewPublisher | undefined {
	if (policy === undefined || policy.review === null) {
		return undefined;
	}
	return new BunFetchGithubReviewPublisher({
		policy,
		baseUrl: config.githubBaseUrl ?? undefined,
		token: config.githubToken ?? "",
		fetchImpl: deps.githubFetch,
	});
}

function requireCampaignFlag(flags: Readonly<Record<string, string | true>>): string {
	const value = flags.campaign;
	if (typeof value !== "string" || value.length === 0) {
		throw new CliError("missing campaign id: pass --campaign <id>");
	}
	return value;
}

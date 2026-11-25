/**
 * File-local helper group for scenario 39 (`39-public-exposure.ts`).
 *
 * Mirrors the precedent in `20-preview.helpers.ts` and
 * `26-plan-run-roundtrip.helpers.ts`: the db seeder, the forbidden-token
 * vocabulary's consumers and the route-path derivation live here so the
 * scenario body stays under the per-file line budget. The forbidden-token
 * vocabulary itself lives in `39-public-exposure.vocabulary.ts`, and the
 * leak assertions that consume it in `39-public-exposure.leaks.ts`.
 *
 * Two things here carry the weight of the whole scenario:
 *
 *   1. **Nothing is hand-listed.** The blocked-route set and the
 *      public-route set are derived from `API_ROUTE_POLICIES`, and the
 *      forbidden field names from the exported `REDACTED_*` constants
 *      (warren-946f widened `REDACTED_RUN_FIELDS` past the classification's
 *      original four names — a hand-copied list here would already be
 *      stale). Add a route or a redacted field and this scenario covers it
 *      on the next run without an edit.
 *   2. **Every redacted column is seeded with a unique sentinel.** A
 *      projection that starts leaking a field fails on the VALUE, not just
 *      on the key name — so a rename can't slip a leak past the guard.
 *
 * The seeded rows go in through warren's own repos before the server boots,
 * so the scenario needs no burrow dispatch, no canopy CLI, and no LLM: it
 * is deterministic on any machine and cheap enough to run per-PR.
 */

import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import { openDatabase } from "../../../src/db/client.ts";
import { createRepos, type Repos } from "../../../src/db/repos/index.ts";
import { DEFAULT_SNAPSHOT_PAGE_LIMIT } from "../../../src/runs/events.ts";
import { API_ROUTE_POLICIES } from "../../../src/server/handlers/index.ts";
import { AcceptanceError } from "../lib/assert.ts";
import { SENTINELS } from "./39-public-exposure.vocabulary.ts";

/** Owner of the seeded project; also the whole public org allowlist. */
export const PUBLIC_ORG = "warren-acceptance";
/** The agent the public sweep reads. */
export const PUBLIC_AGENT_NAME = "stub-shell";
/**
 * Agent whose `rendered_json` is deliberately invalid JSON. Reading it
 * forces the handler to raise an untyped SyntaxError — that is how the
 * scenario proves a forced 500 leaks nothing.
 *
 * The row is written by {@link poisonAgentRow} AFTER the public read sweep,
 * not by the seeder: warren-f787 deleted the project tier, so every agent
 * row is now visible to `GET /agents` and a poison row present at seed time
 * would 500 the sweep it is supposed to run beside.
 */
export const POISON_AGENT_NAME = "acceptance-poison-agent";
/** Body of the steering message the anonymous inbox poll must not drain. */
export const INBOX_BODY = "scenario-39: this steering message belongs to the operator";

export interface SeededIds {
	readonly projectId: string;
	readonly runId: string;
	readonly planRunId: string;
	readonly agentName: string;
	readonly poisonAgentName: string;
	readonly seedId: string;
}

export interface SeedPublicInstanceInput {
	/** Scenario-private temp root; the sqlite file lands under `data/`. */
	readonly tmpRoot: string;
	/**
	 * The instance's own operator token. Planted verbatim in an event
	 * payload so the scrubber's env-literal matcher
	 * (`buildEnvSecretPattern`) is exercised, not just its shape patterns.
	 */
	readonly instanceToken: string;
}

/**
 * Build the public instance's database BEFORE warren boots: one project,
 * two agents, one terminal run with every redacted column populated, an
 * event log carrying planted secrets and one internal-only kind, an unread
 * steering message, and a plan-run whose child points at the run.
 *
 * The run is left TERMINAL so warren's boot-time bridge resume has nothing
 * to reattach — that is what keeps the scenario independent of burrow.
 */
export async function seedPublicInstanceDb(input: SeedPublicInstanceInput): Promise<SeededIds> {
	const dataDir = join(input.tmpRoot, "data");
	const localPath = join(dataDir, "projects", PUBLIC_ORG, "sample");
	await mkdir(localPath, { recursive: true });

	const db = await openDatabase({ path: join(dataDir, "warren.db") });
	try {
		const repos = createRepos(db);
		const project = await repos.projects.create({
			gitUrl: `https://github.com/${PUBLIC_ORG}/sample.git`,
			localPath,
			defaultBranch: "main",
			hasSeeds: true,
		});
		await repos.agents.upsert({
			name: PUBLIC_AGENT_NAME,
			renderedJson: {
				frontmatter: { description: "scenario-39 stub", provider: "claude-code", model: "opus" },
				sections: { system: SENTINELS.agentRenderedJson },
				resolvedFrom: SENTINELS.agentResolvedFrom,
			},
		});
		const seedId = "ah-39-1";
		const run = await repos.runs.create({
			agentName: PUBLIC_AGENT_NAME,
			projectId: project.id,
			prompt: "scenario-39: public-exposure regression run",
			renderedAgentJson: {
				frontmatter: { provider: "claude-code", model: "opus" },
				sections: { system: SENTINELS.runRenderedAgent },
			},
			trigger: "manual",
			sandboxId: SENTINELS.runBurrowId,
			sandboxRunId: SENTINELS.runBurrowRunId,
			workerId: SENTINELS.runWorkerId,
			seedId,
		});
		await repos.runs.attachStats(run.id, {
			costUsd: 1.25,
			tokensInput: 4_096,
			tokensOutput: 512,
		});
		await repos.runs.attachPreview(run.id, {
			previewState: "failed",
			previewPort: 41_234,
			previewFailureMessage: `${SENTINELS.runPreviewFailure}: /home/warren/preview.log`,
		});
		await repos.runs.markRunning(run.id);
		await repos.runs.finalize(run.id, "succeeded");

		await seedEvents(repos, run.id, input.instanceToken);
		await repos.runInbox.enqueue({ runId: run.id, body: INBOX_BODY });

		const planRun = await repos.planRuns.create({
			planId: "pl-3900",
			projectId: project.id,
			agentName: PUBLIC_AGENT_NAME,
			promptTemplate: SENTINELS.planRunPromptTemplate,
			providerOverride: SENTINELS.planRunProviderOverride,
			modelOverride: SENTINELS.planRunModelOverride,
			dispatcherHandle: SENTINELS.planRunDispatcherHandle,
			children: [{ seq: 1, seedId }],
		});
		// Walk the legal child lifecycle rather than jumping pending → merged,
		// which the warren-66d2 table refuses and no real writer takes: the
		// coordinator dispatches, then `src/plan-runs/in-flight.ts` settles the
		// merge. Replay both hops so the sentinel-bearing child lands merged.
		await repos.planRuns.updateChild({
			planRunId: planRun.planRun.id,
			seq: 1,
			patch: { runId: run.id, state: "dispatched" },
		});
		await repos.planRuns.updateChild({
			planRunId: planRun.planRun.id,
			seq: 1,
			patch: { state: "merged" },
		});
		// `failureReason` only lands through `transitionTo`, which would move
		// the plan-run to a terminal state — and the stream-cap assertions
		// hold their slots against a LIVE plan-run tail. Plant the sentinels
		// with raw UPDATEs instead, past the state machine (warren-b0bd).
		db.raw
			.query("UPDATE plan_runs SET failure_reason = ? WHERE id = ?")
			.run(SENTINELS.planRunFailureReason, planRun.planRun.id);
		db.raw
			.query("UPDATE plan_run_children SET failure_reason = ? WHERE plan_run_id = ? AND seq = 1")
			.run(SENTINELS.planRunChildFailureReason, planRun.planRun.id);

		return {
			projectId: project.id,
			runId: run.id,
			planRunId: planRun.planRun.id,
			agentName: PUBLIC_AGENT_NAME,
			poisonAgentName: POISON_AGENT_NAME,
			seedId,
		};
	} finally {
		await db.close();
	}
}

/**
 * Write the poison agent row against the LIVE instance's database, after
 * the public read sweep has run (see {@link POISON_AGENT_NAME}).
 *
 * The row goes in through a second sqlite connection on the same file —
 * WAL admits the one writer, and the server reads it back on the next
 * request. `skipMigrations` because the seeder already migrated this
 * database and warren has since booted against it.
 *
 * The value is written with a raw UPDATE: `rendered_json` is a drizzle
 * `{ mode: "json" }` text column, so an unparseable value can only be
 * written past the mapper. Read back through the agents handler it throws
 * an untyped SyntaxError — the 500 path warren-4385 must not narrate.
 */
export async function poisonAgentRow(tmpRoot: string): Promise<void> {
	const db = await openDatabase({
		path: join(tmpRoot, "data", "warren.db"),
		skipMigrations: true,
	});
	try {
		await createRepos(db).agents.upsert({
			name: POISON_AGENT_NAME,
			renderedJson: { sections: { system: "replaced below" } },
		});
		db.raw
			.query("UPDATE agents SET rendered_json = ? WHERE name = ?")
			.run("{ not json", POISON_AGENT_NAME);
	} finally {
		await db.close();
	}
}

/**
 * The transcript half. Nine planted events: a shape-matched credential,
 * the instance's own token, a secret-NAMED field, a DSN / userinfo URL /
 * JWT (warren-6fa0), a dropped-whole `bridge_lost`, `reap_failed` /
 * `spawn_failed` planting `/data/` / `/home/` paths + raw stderr
 * (warren-cbd8), and `watchdog.terminal_reconciled` /
 * `reap.workspace_destroyed` carrying the internal runtime handles
 * warren-d8f4 / warren-5f59 censor on the key (warren-b0bd).
 *
 * After the planted nine, filler events bring the log past
 * `DEFAULT_SNAPSHOT_PAGE_LIMIT` so the scenario can prove an anonymous
 * replay is a bounded page, not the whole transcript (warren-2a8b).
 */
async function seedEvents(repos: Repos, runId: string, instanceToken: string): Promise<void> {
	const ts = "2026-07-27T00:00:00.000Z";
	await repos.events.append({
		runId,
		sandboxEventSeq: 1,
		ts,
		kind: "agent_output",
		stream: "stdout",
		payload: {
			text: `exporting ANTHROPIC_API_KEY=${SENTINELS.eventAnthropicKey} before the call`,
		},
	});
	await repos.events.append({
		runId,
		sandboxEventSeq: 2,
		ts,
		kind: "agent_output",
		stream: "stdout",
		payload: {
			text: `curl -H "Authorization: Bearer ${SENTINELS.eventBearerToken}" https://api.warren.run/runs`,
			note: `and the control plane's own token: ${instanceToken}`,
		},
	});
	await repos.events.append({
		runId,
		sandboxEventSeq: 3,
		ts,
		kind: "tool_use",
		stream: "stdout",
		payload: { input: { apiKey: SENTINELS.eventApiKeyField } },
	});
	await repos.events.append({
		runId,
		sandboxEventSeq: 4,
		ts,
		kind: "agent_output",
		stream: "stdout",
		payload: {
			// A Supabase-style DSN (WARREN_DB_URL shape), a generic userinfo URL,
			// and a JWT — the three shapes warren-6fa0 added to the scrubber.
			dsn: `psql postgresql://postgres:${SENTINELS.eventDsnPassword}@db.proj.supabase.co:5432/postgres`,
			clone: `git clone https://alice:${SENTINELS.eventUserinfoPassword}@example.com/x.git`,
			jwt: `SUPABASE_SERVICE_ROLE_KEY=${SENTINELS.eventJwt}`,
		},
	});
	await repos.events.append({
		runId,
		sandboxEventSeq: 5,
		ts,
		kind: "bridge_lost",
		stream: "system",
		payload: { sandboxId: SENTINELS.runBurrowId, attempts: 3 },
	});
	await repos.events.append({
		runId,
		sandboxEventSeq: 6,
		ts,
		kind: "reap_failed",
		stream: "system",
		payload: {
			step: "mulch_merge",
			message: "mulch stderr: /home/operator/bin/mulch: denied",
			path: "/data/warren/projects/sample/.mulch/infra.jsonl",
		},
	});
	await repos.events.append({
		runId,
		sandboxEventSeq: 7,
		ts,
		kind: "spawn_failed",
		stream: "system",
		payload: { step: "spawn", message: "clone stderr: /home/operator/.ssh unreadable" },
	});
	await repos.events.append({
		runId,
		sandboxEventSeq: 8,
		ts,
		kind: "watchdog.terminal_reconciled",
		stream: "system",
		payload: { sandboxRunId: SENTINELS.eventWatchdogBurrowRunId, state: "succeeded" },
	});
	await repos.events.append({
		runId,
		sandboxEventSeq: 9,
		ts,
		kind: "reap.workspace_destroyed",
		stream: "system",
		payload: { sandboxId: SENTINELS.eventReapBurrowId, archived: true },
	});

	// Filler past the snapshot page bound (warren-b0bd). Seq starts at 1000
	// so the planted nine stay at the head of the replay where the sentinel
	// assertions can find them.
	const filler = DEFAULT_SNAPSHOT_PAGE_LIMIT + 1 - 9;
	for (let i = 0; i < filler; i++) {
		await repos.events.append({
			runId,
			sandboxEventSeq: 1000 + i,
			ts,
			kind: "agent_output",
			stream: "stdout",
			payload: { text: `scenario-39 filler event ${i}` },
		});
	}
}

/* ----------------------------------------------------------------------- */
/* Route derivation                                                         */
/* ----------------------------------------------------------------------- */

/** Stand-in for a param whose value the route never reaches (blocked routes). */
const UNREACHED_PARAM = "acceptance-unreached";

export interface RouteCall {
	readonly method: string;
	readonly pattern: string;
	readonly path: string;
}

function fillParams(pattern: string, ids: SeededIds): { path: string; concrete: boolean } {
	let concrete = true;
	const path = pattern.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, (_match, name: string) => {
		if (name === "name") return ids.agentName;
		if (name === "id" && pattern.startsWith("/runs/")) return ids.runId;
		if (name === "id" && pattern.startsWith("/plan-runs/")) return ids.planRunId;
		if (name === "id" && pattern.startsWith("/projects/")) return ids.projectId;
		concrete = false;
		return UNREACHED_PARAM;
	});
	return { path, concrete };
}

/**
 * Every route an anonymous caller must be REFUSED — derived as "policy is
 * neither `anonymous` nor `readPublic`", so a route added tomorrow with a
 * `readOperator` / `dispatch` / `admin` policy is covered without an edit.
 */
export function blockedRouteCalls(ids: SeededIds): readonly RouteCall[] {
	return API_ROUTE_POLICIES.filter(
		(r) => r.policy !== "anonymous" && r.policy !== "readPublic",
	).map((r) => ({ method: r.method, pattern: r.pattern, path: fillParams(r.pattern, ids).path }));
}

/**
 * Every GET an anonymous caller may reach. Params must resolve to a REAL
 * seeded id — a route whose param this helper can't fill would otherwise
 * 404 and the leak sweep would pass vacuously, so an unfillable one is a
 * hard error telling the next author to extend `fillParams`.
 */
export function publicGetCalls(ids: SeededIds): readonly RouteCall[] {
	return API_ROUTE_POLICIES.filter(
		(r) => r.method === "GET" && (r.policy === "anonymous" || r.policy === "readPublic"),
	).map((r) => {
		const { path, concrete } = fillParams(r.pattern, ids);
		if (!concrete) {
			throw new AcceptanceError(
				`scenario-39: no seeded id for a param of readable route GET ${r.pattern} — extend fillParams() so the leak sweep reads a populated body`,
			);
		}
		return { method: r.method, pattern: r.pattern, path };
	});
}

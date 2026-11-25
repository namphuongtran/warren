/**
 * The forbidden-token vocabulary for scenario 39 (`39-public-exposure.ts`).
 *
 * Pure data with no boot dependencies, so the leak assertions
 * (`39-public-exposure.leaks.ts`), the db seeder
 * (`39-public-exposure.helpers.ts`) and the unit tests can share it without
 * loading the seeder and the route derivation.
 */

import { REDACTED_AGENT_FIELDS } from "../../../src/server/handlers/agents.ts";
import {
	REDACTED_PLAN_RUN_CHILD_FIELDS,
	REDACTED_PLAN_RUN_FIELDS,
} from "../../../src/server/handlers/plan-runs-projection.ts";
import { REDACTED_PROJECT_FIELDS } from "../../../src/server/handlers/projects.ts";
import { REDACTED_RUN_ANALYTICS_FIELDS } from "../../../src/server/handlers/runs/analytics.ts";
import { REDACTED_RUN_FIELDS } from "../../../src/server/handlers/runs/lifecycle.ts";

/**
 * Unique strings planted in every redacted column / secret-shaped payload.
 * Absence of each from every anonymous body is the value-level half of the
 * guard (the key-name half is {@link FORBIDDEN_FIELD_NAMES}).
 */
export const SENTINELS = {
	runRenderedAgent: "LEAKSENTINEL-RUN-RENDERED-AGENT-JSON",
	runBurrowId: "brw_LEAKSENTINELBURROWID",
	runBurrowRunId: "brun_LEAKSENTINELBURROWRUNID",
	runWorkerId: "wrk-LEAKSENTINELWORKERID",
	runPreviewFailure: "LEAKSENTINEL-PREVIEW-STDERR-TAIL",
	agentRenderedJson: "LEAKSENTINEL-AGENT-SYSTEM-PROMPT",
	agentResolvedFrom: "LEAKSENTINEL-CANOPY-RESOLVED-FROM",
	eventAnthropicKey: "sk-ant-LEAKSENTINELANTHROPICKEY0001",
	eventBearerToken: "LEAKSENTINELBEARERTOKEN00000001",
	eventApiKeyField: "LEAKSENTINEL-APIKEY-FIELD-VALUE",
	// The password embedded in a Supabase-style DSN's URL userinfo
	// (WARREN_DB_URL shape). warren-6fa0: the userinfo pattern redacts it.
	eventDsnPassword: "LEAKSENTINELDSNPASSWORD00000001",
	// A generic `https://user:pass@host` userinfo credential (warren-6fa0).
	eventUserinfoPassword: "LEAKSENTINELUSERINFOPW0000001",
	// `watchdog.terminal_reconciled` payload handle (warren-d8f4 censored the
	// key; warren-b0bd plants the value so the guard has a live target).
	eventWatchdogBurrowRunId: "brun_LEAKSENTINELWATCHDOG0001",
	// `reap.workspace_destroyed` payload handle (warren-5f59, same story).
	eventReapBurrowId: "brw_LEAKSENTINELREAPWS0000001",
	// plan_runs / plan_run_children redacted columns (warren-8793). Planted
	// so a projection regression fails on the VALUE, not just the key name.
	planRunPromptTemplate: "LEAKSENTINEL-PLANRUN-PROMPT-TEMPLATE",
	planRunDispatcherHandle: "LEAKSENTINEL-DISPATCHER-HANDLE",
	planRunProviderOverride: "LEAKSENTINEL-PROVIDER-OVERRIDE",
	planRunModelOverride: "LEAKSENTINEL-MODEL-OVERRIDE",
	planRunFailureReason: "LEAKSENTINEL-PLANRUN-FAILURE-REASON",
	planRunChildFailureReason: "LEAKSENTINEL-CHILD-FAILURE-REASON",
	// A full JWT (three base64url segments). warren-6fa0: the JWT pattern
	// redacts it whole. `eyJ` header prefix keeps it off ordinary identifiers.
	eventJwt:
		"eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiTEVBS1NFTlRJTkVMSldUUk9MRSJ9.LEAKSENTINELJWTSIGNATURE0001",
} as const;

/**
 * Field names that must never appear in an anonymous body, derived from the
 * exported complements of each public projection. `assertNoLeak` matches
 * each as a whole identifier (namphuongtran/warren#118), so no name here may
 * EQUAL a field the projections keep; one that only prefixes a kept field
 * (`qualityGate` / `qualityGateOutcome`) is sound. The leaks test pins it.
 *
 * `REDACTED_RUN_TOTALS_FIELDS` (`cost`) and `REDACTED_RUN_GROUP_FIELDS`
 * (`costUsd` / `priced`) are deliberately NOT here — those names DO equal
 * public ones, so the scenario holds them structurally instead
 * (`assertAnalyticsRollupsAbsent`).
 */
export const FORBIDDEN_FIELD_NAMES: readonly string[] = [
	...new Set(
		[
			...REDACTED_RUN_FIELDS,
			...REDACTED_PROJECT_FIELDS,
			...REDACTED_AGENT_FIELDS,
			...REDACTED_RUN_ANALYTICS_FIELDS,
			...REDACTED_PLAN_RUN_FIELDS,
			...REDACTED_PLAN_RUN_CHILD_FIELDS,
		].filter(
			// `failureReason` collides with a PUBLIC runs field (runs serve it
			// to spectators), so the raw body scan can't carry it — the plan-run
			// bodies hold it structurally instead (`assertPlanRunFailureReasonAbsent`),
			// and the planted SENTINELS still cover it at the value level.
			(name) => name !== "failureReason",
		),
	),
	// Envelope-level, not a row column, so it belongs to no REDACTED_* list:
	// the instance-wide all-time rollup `GET /runs` drops for a spectator
	// (warren-946f).
	"costTotalUsd",
	// Nested inside the agent `renderedJson` the projection drops whole; named
	// explicitly because it is the canopy source-path disclosure the
	// classification calls out by name (warren-4f6c).
	"resolvedFrom",
];

/**
 * Host-layout shapes no anonymous body may carry. `/data/` catches the
 * projects root under warren's data dir (the shape `localPath` has in every
 * container deploy AND under this scenario's temp root); `/home/` catches a
 * developer-machine clone path.
 */
export const FORBIDDEN_PATH_FRAGMENTS: readonly string[] = ["/data/", "/home/"];

/**
 * A `Bearer` on the wire is only acceptable when the scrubber has already
 * replaced the credential after it — `[redacted]` (warren-1cb7 keeps the
 * header prefix on purpose so the redaction still reads as a header). This
 * is the one place the scenario deviates from a flat "no `Bearer `"
 * substring rule: any OTHER follower long enough to BE a credential is a
 * leak. The 12-char floor keeps ordinary prose out (several 403 envelopes
 * hint "authenticate with an operator bearer token") while still catching
 * every real token shape — the same floor `buildEnvSecretPattern` uses to
 * decide a value is worth redacting at all.
 */
export const UNREDACTED_BEARER = /bearer\s+(?!\[redacted\])[\w.\-+/=~]{12,}/i;

# Provider-error retry

**Kind:** contract
**Design state:** approved
**Delivery:** shipped
**Arrived:** 2026-08-22
**Shipped:** v0.17.0
**Current truth:** `src/runs/retry/provider-retry.ts` and
`src/server/main/provider-retry-wiring.ts`

The run-level fallback for a model provider that fails transiently
(warren-339d). The pi harness owns the in-stream reconnect, which warren
cannot reach from the control plane, so when a run reaps
`failed`/`provider_error` on a network-class message, warren dispatches a
replacement run and records the lineage on both streams. The attempt
bound, the exhausted and skipped events, and this record arrived with
warren-ac61.

**Grounds:** [`PHILOSOPHY.md`](../PHILOSOPHY.md) operating rule 6
("read-only as long as possible"): the module is an observe-only Tier-1
consumer of the [observation bus](./tier1-observation-bus.md), not a
branch inside the reap path.

---

## 0. Trigger

The module registers one `post_reap` hook. Every gate below fails closed,
so any uncertainty means no retry.

| Gate | Source |
|---|---|
| The run reaped `failed` | `envelope.payload.outcome` |
| `failureReason === "provider_error"` | `runs.failure_reason` |
| The run still belongs to a project | `runs.project_id` |
| The run is not a plan-run child | `trigger` is neither `plan-run` nor `auto_plan_run` |
| The lineage has attempts left | see [the bound](#2-the-bound) |
| The provider's terminal error reads transient | see [classification](#1-classification) |

A plan-run child is excluded because the coordinator owns child-level
retry (warren-6de9). A run-level retry underneath it would double-dispatch
the child.

## 1. Classification

`classifyProviderError` is the single discriminator, and it is pure. It
returns `transient` (retry), `durable` (the provider rejected the request
itself, so a retry fails the same way), or `unknown` (unrecognized, which
fails closed). Three tiers, in order:

1. **Structured `httpStatus`**, captured on the `reap.provider_error`
   payload by warren-4001's enrichment. `>= 500` is transient, `400` to
   `499` is durable. This tier exists because a 5xx whose prose never
   spells out the code used to fail closed as `unknown` (warren-f8b2).
2. **The structured `upstreamBody`**, which carries the provider's real
   rejection text even when the harness surface message is opaque, such as
   pi's `Provider returned error` (warren-eaa6). Classified by the prose
   rules below; `unknown` falls through to tier 3.
3. **The free-prose message**, by the same rules.

Inside a tier, durable wins over transient, so a message that names both a
symptom and a cause ("request failed: 401 ...") does not retry.

**Durable patterns** cover auth and permission (401, 403, api key,
forbidden), model rejection (404, model not found, `not_found_error`),
quota and billing (402, credit balance, quota, insufficient), rate
limiting (429, rate limit, too many requests), and malformed requests
(400, `invalid_request`). Rate limiting is durable rather than transient
because a run-level redispatch has no backoff, so an immediate retry would
hit the same limiter.

**Transient patterns** cover the connection class (connection lost, reset,
refused, closed, aborted; `ECONNRESET`, `EPIPE`, socket hang up, fetch
failed, DNS), the timeout class (`ETIMEDOUT`, timed out), and the upstream
class (any 5xx token, internal server error, bad gateway, service
unavailable, gateway timeout, overloaded, upstream).

Both lists live in `src/runs/retry/provider-retry.ts` as
`DURABLE_PATTERNS` and `TRANSIENT_PATTERNS`. Which message belongs in
which list is the subject of its own issue queue, not of this record.

## 2. The bound

`MAX_PROVIDER_RETRIES` caps how many auto-dispatched retries one lineage
may hold. The origin run is not an attempt, so at 2 a transient failure is
redispatched twice before warren stops.

Each dispatched retry carries a `spawn.provider_retry` event on its own
stream, so the count is a property of the lineage rather than of a column,
and it survives a restart with no new schema. `countProviderRetries` walks
backwards from the run that just failed and counts the runs carrying that
stamp.

Two details of the walk are load bearing:

- **`retryOf` hops are not the count.** `src/runs/retry/infra-lost-retry.ts`
  writes that column too, so an infra-lost retry that later dies on the
  provider would otherwise arrive already holding an attempt it never
  spent. Only the stamp counts.
- **A run without the stamp does not end the walk.** An infra-lost retry
  in the middle of a provider lineage is not a fresh start, so the walk
  passes through it and keeps counting.

`parentRunId` is followed only from a run that carries the stamp, which is
the pre-warren-eaa6 provider-retry row shape. A plain `continue` clone is
never walked. The walk stops once the cap is reached, so it reads at most
`MAX_PROVIDER_RETRIES` rows of the chain.

**No backoff.** The redispatch is immediate. The observation bus does not
await its subscribers, so a sleep here would not stall the run loop, but it
would live only in process memory: a control-plane restart during the wait
would drop the retry with nothing on the stream to say so. The classes that
do want spacing, rate limits above all, are already durable.

## 3. Events

Five kinds, all in `PROVIDER_RETRY_EVENTS`. The first two are the lineage;
the last three are the record of a decision.

| Kind | Stream | Payload |
|---|---|---|
| `spawn.provider_retry` | the new run | `retriedFromRunId`, `providerError` |
| `reap.provider_retry_dispatched` | the failed run | `newRunId`, `providerError` |
| `reap.provider_retry_failed` | the failed run | `error` |
| `reap.provider_retry_exhausted` | the failed run | `attempts`, `maxAttempts` |
| `reap.provider_retry_skipped` | the failed run | `verdict`, `providerError` |

`reap.provider_retry_failed` covers a redispatch that threw. The throw is
recorded rather than propagated, because the bus swallows it either way and
this puts the failure on the operator's stream.

One gate is still silent. A run marked `provider_error` whose stream holds
no `reap.provider_error` event with a message returns without an event.
That is a missing-data case rather than a policy decision, and inventing a
`verdict` for it would misreport a classifier run that never happened.

The silent gate runs before the attempt bound, so it stays silent even on a
lineage that has spent every attempt. An exhaustion event there would name a
bound that never decided anything, because the classifier never ran. The
order is also the cheaper one. The signal sits in the events the handler
already read, and the bound reads chain rows.

## 4. The automatic retries beside each other

Warren has four automatic retries. They do not overlap, and each one
stands down where another owns the case.

| | Cause | Bound | Where the budget lives |
|---|---|---|---|
| Provider retry (this record) | `provider_error`, transient | `MAX_PROVIDER_RETRIES` | `spawn.provider_retry` stamps on the lineage |
| Infra-lost retry (`src/runs/retry/infra-lost-retry.ts`) | `sandbox_run_lost`, `preempted` | one | the `runs.retry_of` link itself |
| Plan-run child retry ([coordinator](./plan-run-coordinator.md)) | a retryable child failure cause | `MAX_CHILD_RETRIES` | `plan_run_children.retry_count` |
| Quota auto-resume (`src/runs/retry/quota-resume.ts`) | `quota_exhausted` | `MAX_QUOTA_RESUMES` | `spawn.quota_resume` stamps on the lineage |

The infra-lost retry also inherits the original run's cost cap minus what
the first attempt spent, so the two attempts share one shrinking ceiling.
The provider retry has no equivalent, because the failure it answers
happens before the agent burns the budget it was given.

### Quota auto-resume (namphuongtran/warren#30)

A rate limit stays durable for this record, because an immediate redispatch
hits the same limiter. A run the provider refused because the credential's
usage window is spent reaps `quota_exhausted` instead, and a separate
consumer waits for the reset rather than retrying at once.

The `post_reap` hook writes `reap.quota_resume_scheduled` on the failed run.
Its `resumeAt` is the window's `resetsAt` plus 60 seconds and up to 120
seconds of jitter. A 60-second worker dispatches each due resume. The
successor builds on the stopped run's pushed commits when there are any, and
otherwise re-dispatches its config from the same base. It reads the pushed
branch from `runs.branch`: a `continue` clone for the run's own composed
branch, a clone cut from a `newBranch` name, and the same `targetBranch` for a
run that pushed to an operator branch. Its dispatch origin is
`resume_quota`. No table holds the schedule. The newest decision event on the
failed run is the state, so a pending resume survives a restart. The worker
writes a `reap.quota_resume_started` claim before it spawns, so a process
that dies mid-dispatch never spawns a second successor.

A due resume that the dispatch guard still refuses (a newer report moved the
reset) is scheduled again at the new reset and keeps its attempt. Plan-run
children are skipped, because the coordinator retries a `quota_exhausted`
child itself: the guard defers that retry until the reset, and a child that
pushed commits is retried as a `continue` clone of its branch.

| Kind | Stream | Payload |
|---|---|---|
| `reap.quota_resume_scheduled` | the failed run | `resumeAt`, `resetsAt`, `attempt`, `maxAttempts`, `mode` |
| `reap.quota_resume_started` | the failed run | `attempt` |
| `reap.quota_resume_dispatched` | the failed run | `newRunId`, `attempt`, `mode` |
| `reap.quota_resume_failed` | the failed run | `error` |
| `reap.quota_resume_exhausted` | the failed run | `attempts`, `maxAttempts` |
| `reap.quota_resume_skipped` | the failed run | `reason`: `plan_run_child`, `no_project`, `reset_unknown` |
| `spawn.quota_resume` | the successor | `resumedFromRunId`, `attempt`, `mode` |

### Held dispatches (namphuongtran/warren#30)

A new dispatch into a spent window answers 429 by default. A `POST /runs`
with `onQuotaExhausted: "hold"` (`warren run --hold-on-quota`) is held
instead. The scheduler always holds: a cron, scheduled-seed or CI-fixer
fire goes through `spawnOrHoldRun`, so a refused fire still consumes its
slot (or clears the seed's `scheduledFor`) with the held run's id, and the
tick logs `scheduler.dispatch_held`. A held automatic run is `queued`, so it
counts against the automatic-run cap until it is released. `spawnOrHoldRun` creates the run row `queued` with no workload and
answers 202 with `quotaHold` (`reason`, `resetsAt`, `releaseAt`) and
`sandbox: null`. The client keeps the run id and can tail it as usual. A
`dispatch.quota_held` event on the run carries the dispatch request without
any credential, and the run detail page shows "Deferred: provider quota"
until the release.

The quota hold releaser (`src/runs/quota/hold-release.ts`) ticks every 60
seconds beside the resume worker. It launches each held run whose
`releaseAt` has passed (the reset plus the same delay and jitter as a
resume) as the same row. `launchHeldRun` replays the stored request through
the same preparation as `spawnRun` (`src/runs/spawn/prepare.ts`) and mints a
fresh git credential. The state is on the stream again: the
`dispatch.quota_release_started` claim stops a restart mid-launch from
launching twice. When the guard still refuses (a newer report moved the
reset), the release writes a new `dispatch.quota_held` at the new reset. A
held run cancels like any queued run, and the releaser never launches a run
that is no longer `queued` with no workload. Any other launch failure fails
the row `never_started`.

`GET /runs` reads the same events into the operator-only `quotaHold` overlay
(`src/runs/quota/hold-view.ts`): a run is held while it is `queued` with no
workload and its newest hold event is `dispatch.quota_held`. The runs table
and cards show it as `deferred`, with the wait until its release. The
Operations page reads `GET /provider-quota` and shows an alert for each
credential whose window is spent or that the provider flags as nearly spent.

| Kind | Stream | Payload |
|---|---|---|
| `dispatch.quota_held` | the held run | `reason`, `resetsAt`, `releaseAt`, `request` |
| `dispatch.quota_release_started` | the held run | none |
| `dispatch.quota_released` | the held run | `sandboxId` |
| `dispatch.quota_release_failed` | the held run | `error` |

### Utilization threshold (namphuongtran/warren#30)

A rejected window refuses dispatch on every credential. The utilization
threshold refuses earlier, and is off by default. The project's
`admission.maxProviderUtilization` sets it, and
`WARREN_PROVIDER_QUOTA_MAX_UTILIZATION` sets the deployment default. Each is a
share of the window, above 0 and at most 1. The project value wins. An
invalid env value leaves the threshold off. While the credential's newest
report says the binding window is at or past the threshold and its
`resetsAt` is still ahead, `spawnRun` refuses the dispatch the same way it
refuses a spent window: `ProviderQuotaExhaustedError`, 429
`provider_quota_exhausted`, and a `Retry-After` that ends at the reset. The
hold, the plan-run deferral and the quota resume all treat the refusal the
same way, and `force` overrides it. A report with no utilization never
trips the threshold. Runs already in flight are not touched. The threshold
only keeps new runs from taking the rest of the window.

### A killed agent is not a provider error (warren-a757)

An agent that dies without its own terminal envelope gets a synthesized
`agent_end` from the runtime, and that envelope carries an error message.
A Spot node reclaimed under a run pod produces exactly this shape with
exit 137. Before warren-a757 reap read it as `provider_error`, so the
provider retry skipped it as not transient and the infra-lost retry never
saw it.

Reap now asks the runtime first, through `src/runs/reap/infra-loss.ts`.
The check runs only for a synthesized exit, and never once commits were
pushed. A runtime verdict of `preempted` or a lost pod lands the run on
`preempted` or `sandbox_run_lost`, which the infra-lost retry owns. A
real `OOMKilled` container lands on `oom_killed`. Reap records
`reap.infra_loss` in place of `reap.provider_error`, so this retry never
fires for these runs. Any other verdict keeps `provider_error`.

## 5. Wiring

`src/server/main/provider-retry-wiring.ts` builds the extension at boot
and registers it on the observation bus, after the bridge registry exists,
because the redispatch attaches one. The module reads
[the bus](./tier1-observation-bus.md) and writes only run events and one
`spawnRun` call. It holds no state of its own.

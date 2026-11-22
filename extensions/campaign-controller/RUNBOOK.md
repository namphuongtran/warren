# Campaign controller operator runbook — OpenClaw V0 dry run

This runbook is the operator boundary for the V0 campaign controller
(plan [pl-91b6](../../docs/design/campaign-controller.md), step 11,
warren-56dd). Read it end to end before the first dry run. It states the
exact dry-run boundary, the prerequisites, the commands, the evidence to
collect, what restart recovery does, when to stop, and which actions need
separate explicit authorization.

## 1. The exact dry-run boundary

V0 is dry-run by **structural absence**, not by a flag:

- The production GitHub transport (`src/github/http-transport.ts`) exposes one
  operation, `read`, and refuses any method other than `GET` and `HEAD`
  *before* any network I/O. No mutation method exists on that transport.
- **Phase 2 (warren-84da) added exactly one mutation**, in a separate class
  (`src/github/pr-create.ts`): executing a journaled cross-fork PR intent.
  It stays structurally absent under a dry-run policy — the creator cannot
  be constructed unless the validated repository policy enables
  `mutations.createPullRequest`, and enabling that flag changes the policy
  digest, which requires a fresh owner-approved campaign (§8). Its target
  is pinned to the policy upstream's `/pulls` collection.
- The repository-policy schema rejects every other enabled mutation flag —
  `createPullRequest` is the single flag with an executable code path.
- The CLI refuses `--live` and `--execute` as usage errors. There is no
  live flag: the capability comes only from the approved policy file plus
  a GitHub credential.
- Under a dry-run policy, no code path posts a PR; under any policy, no
  code path comments, replies, claims an issue, pushes a
  commit, updates a branch, or enables auto-merge.
- No code path reads GKE secrets, Kubernetes secrets, or any secret store.
- No code path performs a real paid Warren dispatch against a live Warren
  unless separately authorized (§8).

The controller may: read public GitHub repository, issue, PR, review,
comment, check, and notification state; dispatch to a **fake or separately
authorized** Warren; render and journal a prospective cross-fork pull
request; and write only its own SQLite store.

## 2. Prerequisites

- Bun ≥ 1.1.
- The committed OpenClaw data in `profiles/`:
  `openclaw.repository-policy.json` (upstream 20-open-PR limit, controller
  caps 5 open / 2 per day, required checks `ci`, `typecheck`, `lint`) and
  `openclaw.campaign-manifest.example.json`.
- A per-campaign manifest derived from the example: replace `promptDigest`
  with the approved `prompt` text, restrict `issues` to the explicit ordered
  issue list, and recompute the approval digest.
- The bot fork `warren-run-bot/openclaw` exists and Warren pushes run
  branches to it (in the fake-server dry run this is simulated).
- A policy review record: the snapshot's source URL, `fetchedAt`, and
  `sha256` are within `stalenessMaxDays` (90). A stale or digest-mismatched
  policy fails closed at admission.

## 3. Environment variables (names only — never commit values)

- `WARREN_BASE_URL` — Warren API base URL.
- `WARREN_API_TOKEN` — Warren bearer credential. The only Warren secret
  input; never a flag, never echoed, never journaled.
- `GITHUB_TOKEN` — optional read-only GitHub credential. The only GitHub
  secret input.
- `GITHUB_API_BASE` — GitHub API base URL.
- `CAMPAIGN_DB_PATH` — controller SQLite database path.
- `CAMPAIGN_MANIFEST_PATH` — campaign manifest file.
- `CAMPAIGN_POLICY_PATH` — repository-policy snapshot file.
- `CAMPAIGN_BOT_GRAMMAR_PATH` — optional profile review-bot grammar file
  (e.g. `profiles/openclaw.bot-grammar.json`). When set, the tick's
  reconciler classifies review-bot output into durable feedback; when
  absent, classification no-ops. A bad path or invalid grammar aborts the
  tick at startup.
- `CAMPAIGN_SUMMARIES_PATH` — operator change summaries (JSON, keyed by
  issue number).

No fixture, golden, log line, journal row, or test output in this package
contains a real credential.

## 4. Commands

Run from `extensions/campaign-controller`:

```bash
bun install
bun test                    # full standalone suite (284 tests)
bun run acceptance          # the OpenClaw V0 end-to-end dry-run scenario
bun run typecheck
bun run lint

bun run src/cli/main.ts manifest validate --manifest <m> --policy <p>
bun run src/cli/main.ts manifest import --manifest <m> --policy <p>
bun run src/cli/main.ts approve --campaign <id> --digest <sha256> --by <name>
bun run src/cli/main.ts tick --campaign <id>            # dry-run tick
bun run src/cli/main.ts status --campaign <id>
bun run src/cli/main.ts journal --campaign <id>
bun run src/cli/main.ts attention list --campaign <id>
```

Output is NDJSON by default (`--format human` for readable text). Exit codes:
0 ok, 1 usage, 2 invalid input, 3 invalid config, 4 refused, 5 upstream
failure.

## 5. Evidence checklist

After a dry run, collect and review:

- [ ] `status` shows the campaign reached its expected state with exactly one
      `warren_dispatch` action per dispatched work item.
- [ ] `journal` shows the dispatch action journaled `planned` **before** the
      request and settled `succeeded` with the correlated run id and branch.
- [ ] `journal` shows exactly one `pr_intent` action in state `planned`. The
      intent is the exact cross-fork request (`head
      warren-run-bot:<branch>`, base the upstream default branch, draft)
      — evidence only, never posted.
- [ ] Re-ticking after the terminal state adds no new actions or events
      (stable single actions/events/attention).
- [ ] The budget report settles: available = cap − actual terminal cost.
- [ ] `attention list` is empty, or every item has a reviewed reason
      (`requested_changes`, `maintainer_comment`, `failing_checks`,
      `dispatch_uncertain`, `human_takeover`, `policy_changed`, …).
- [ ] Every attention item is untrusted upstream text treated as data —
      nothing in the store interpreted it as a command.

## 6. Restart recovery

The controller state is one SQLite database in WAL mode. On restart:

1. Abandoned leases expire; the next tick claims the campaign.
2. Known run ids reconcile through safe, retryable `GET /runs/:id` reads.
3. A dispatch whose response was lost settles `uncertain`, moves the work
   item to `dispatch_uncertain`, keeps the full reservation, and raises an
   attention item. It is **never re-POSTed** — not by this process and not
   after a restart — because Warren's idempotency store is not durable
   across a Warren restart and a retry could duplicate paid work.
4. GitHub events deduplicate on repository + kind + node id + content
   digest, so reordered pages, replayed notifications, and restarts land
   exactly once.

The acceptance scenario proves all four properties against the fake
servers, including a mid-flight controller and Warren restart.

## 7. Stop conditions

Stop the controller and page the operator when:

- any work item enters `dispatch_uncertain` (duplicate-spend risk);
- the budget ledger cannot settle a terminal cost after its grace period;
- repeated infrastructure failures trip the circuit breaker;
- a protected path or policy digest mismatch appears;
- the campaign hits its cap, daily cap, or expiry; or
- any action falls outside the approval envelope.

Every one of these lands as a durable attention item; none widens the
boundary on its own.

## 8. Separate explicit authorization required

None of the following is authorized by this runbook, by a campaign approval,
or by possession of any credential. Each needs its own explicit owner
approval over a code revision that adds the exact capability:

- a **real paid Warren dispatch** (any run against a live Warren);
- posting a **real pull request**. The code path exists as of Phase 2
  (warren-84da), but posting still requires ALL of: (1) a repository-policy
  snapshot with `mutations.createPullRequest: true`, (2) the owner
  importing + approving a campaign bound to that policy's digest (the flag
  changes the digest, so no standing approval carries over), and (3) a
  GitHub credential in the deployment. The first live PR is one issue and
  one PR under such a fresh approval;
- editing, closing, or reopening a **real pull request**;
- **claiming an issue** or creating/editing an issue;
- posting or editing any **comment or reply**, including re-review requests
  and thread resolutions;
- publishing **review statuses and review comments** (namphuongtran/warren#18).
  The code path exists, but it runs only with a repository-policy `review`
  block approved under a fresh campaign digest and a GitHub credential in
  the deployment;
- any **credential handoff** (issuing, rotating, or wiring tokens into the
  deployment);
- any **GKE or secret inspection** (reading Kubernetes/GKE secrets, secret
  managers, or credential stores).

The first live PR is one issue and one PR under a new approval — not a
standing campaign authorization. See
[docs/design/campaign-controller.md](../../docs/design/campaign-controller.md)
§7.1 and §10.1 for the full permission and response ladders.

## 9. Recorded validation (2026-08-26, plan pl-91b6 step 11)

```text
$ bun run acceptance
  2 pass / 0 fail / 77 expect() calls
  - proves the full fake-server lifecycle with stable single state
  - an uncertain dispatch is never retried, before or after restart

$ bun test
  284 pass / 0 fail / 1568 expect() calls (24 files)

$ bun run typecheck
  tsc --noEmit -p tsconfig.json — clean

$ bun run lint
  biome check src — Checked 70 files, no fixes, no errors
```

The end-to-end scenario boots fake Warren and fake GitHub, imports and
approves the committed OpenClaw profile plus a digest-bound one-issue
campaign, dispatches exactly once, reconciles terminal success on the fork
branch `warren/issue-812`, renders exactly one cross-fork PR intent, ingests
duplicated and reordered review/check/comment pages, restarts both the
controller store and Warren, and asserts stable single
actions/events/attention with a settled budget (cap 10000¢, available 9875¢
after a 1.25 USD run). The negative probes prove every recorded GitHub
request was GET, no credential reached any durable payload, and the
uncertain dispatch was never re-POSTed across restart.

## 10. Cross-model review gate (namphuongtran/warren#18)

The review policy is opt-in per repository. With no `review` block in the
repository policy, the tick has no `review` stage and nothing below runs.

### Turning it on

1. Add a `review` block to the repository-policy snapshot (see the
   README). Pick a reviewer model from a different vendor than the
   campaign's builder where you can: `provider`/`model` override the
   `reviewer` built-in's default (the opus tier). The reviewer dispatches
   on the `pi` runtime, so the warren deployment needs that provider's
   credential.
   For an independent panel, list more seats under `additionalReviewers`
   and set `quorum` (see the README). Give each seat a different
   `provider`, and make sure the deployment holds every one of those
   credentials. Import adds an advisory to `warnings` when no seat names
   a provider other than the manifest's `warren.provider`.
2. To close the fix loop, also set `mutations.followUpPush: true` in the
   same snapshot. Each change request then starts a follow-up run on the
   PR branch under the manifest's agent, provider, and model, and the
   pushed head is reviewed again. Without it, a change request stops at a
   `failure` status and the findings on the PR.
3. Import and approve a campaign bound to the new policy digest. The block
   changes the digest, so no earlier approval carries over.
4. Set `GITHUB_TOKEN` to a credential that can write commit statuses and
   pull-request reviews on the upstream repository. The reviewer run never
   receives it.
5. On the upstream repository, add a branch-protection rule (or ruleset)
   for the default branch that **requires the status check** named by
   `statusContext` (`warren/review` unless you set another). That rule is
   the merge gate. Warren's own auto-merge arming needs no change: it
   cannot merge past a required check that is pending, failing, or absent.

### What each status means

| State on the head SHA | Meaning | Operator action |
|---|---|---|
| none | The head moved and no tick has reviewed it yet | Wait for the next tick |
| `pending` | Reviewer runs are working on this exact SHA; with a panel, until every seat finishes | None |
| `success` | The reviewer (or a quorum of the panel) approved this SHA | None; a new push resets it |
| `success` + `review_seat_failed` attention | The panel's quorum approved, but a seat produced no verdict (refused dispatch, failed run, missing verdict); the detail lists each failed seat | Check that seat's provider credential and agent; a seat that fails every round silently narrows the panel |
| `failure` | Changes requested; findings recorded for the fixer. With a panel, the quorum was missed and at least one seat objected | With `followUpPush`, none: a fixer run is on its way. Without it, fix by hand |
| `failure` + `follow_up_stopped` attention | The fixer run failed, pushed elsewhere, left the head unchanged, or its dispatch was refused or unconfirmed | Read the run; push a fix by hand (the new head is reviewed) |
| `failure` + `review_needs_human` attention | The fix loop hit `maxRounds` | Take the PR over by hand |
| `error` + `review_failed` attention | The run failed, or ended without a valid verdict. With a panel (`quorum_unmet`), failed seats kept the approvals below the quorum and no seat objected; the attention detail lists each failed seat | Read the runs; push again or fix by hand |

A review runs once per SHA. A failed review is not retried on the same
SHA; a new push gets a new review.

### Known limits

- A panel decides only after every seat has finished, so the slowest
  reviewer sets the latency. A seat whose dispatch was refused fails at
  once and counts as a non-approval. An outvoted dissent appears in the PR
  comment but never reaches the fixer.

- The verdict rides the reviewer's transcript (`GET /runs/:id/events`)
  until the structured handoff report (namphuongtran/warren#21) lands.
- A new review waits while a build or fixer run for the work item is
  live, because that run will move the head anyway.
- Review actions (`review_run`, `review_status`, `review_comment`) are
  journaled without a work item, so they never collide with the
  one-active-attempt rule. Find them with `journal --campaign <id>`; the
  review round ties each one back to its work item.
- The fixer half of the loop is the tick's `follow_up` stage
  (`src/tick/follow-up-stage.ts` over `src/follow-up/coordinator.ts`),
  present only with `mutations.followUpPush`. It also acts on findings the
  upstream reconcile classified from review bots, not only on the
  reviewer's. A finding raised against a head SHA that is no longer the PR
  head is skipped.
- The fixer runs under the campaign manifest's agent, not the `pr-fixer`
  built-in, whose prompt expects CI failure logs. The operator approved
  the manifest's agent identity, so no unapproved agent edits the branch.
- A SHA is reviewed once. A fixer run that ends without moving the head
  leaves the round's `failure` status in place and opens
  `follow_up_stopped`. Push a fix by hand to get a new review.

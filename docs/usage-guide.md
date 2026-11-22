# Warren usage guide

This guide shows how to use Warren, from installation to daily operation.
Every command, config key, and route in this guide was checked against the code at
commit `5e547640`. If the guide and the code disagree, the code is correct. The canonical sources are
[CLI reference](cli-reference.md), [HTTP API](http-api.md), and
[`.warren/` config](design/warren-config.md).

> **Note:** The README says that upstream Warren is **unmaintained from 11/2026**. The fork
> that continues development is `luantaraschi/warren`. For long-term use, follow
> that fork or maintain your own copy.

To learn how the system works internally, read the
[Architecture overview](design/architecture-overview.md).

---

## 1. What Warren is for

Warren takes **one repo and one task**. It runs a coding agent (Claude Code or Pi)
in an isolated sandbox. It delivers the result as **a pushed branch**. A PR,
auto-merge, and issue close are optional steps.

Use Warren when an agent run is no longer a terminal session and has
become a **workload**:

- You must run it unattended (at night, on a schedule).
- You must run many tasks in parallel across many repos.
- You must limit cost, watch logs live, and intervene mid-run.
- Other people on the team must see the run history.
- Code, credentials, and history must stay on your infrastructure.

You do not need Warren if you only chat with Claude Code in a terminal and
commit by hand.

## 2. Basic concepts

| Concept | Meaning | Example |
|---|---|---|
| **Project** | A git repo registered with Warren | `prj_abc123` |
| **Agent** | An agent definition: harness, prompt, model, limits | `claude-code`, `pi`, `planner` |
| **Run** | One agent run on one project. You cannot rerun it. You create a new run. | `run_xyz` |
| **Harness** | The agent process that Warren controls | Claude Code, Pi, Codex |
| **Runtime** | Where the run executes | `local` (bwrap / sandbox-exec), `docker`, `k8s` |
| **Plan-run** | A chain of issues that run in sequence. Each issue waits for the previous issue's PR to merge. | `warren plan run pl_xxx` |
| **Trigger** | A run on a cron schedule | `.warren/triggers.yaml` |

**8 built-in agents** load again at each boot:

| Agent | Role |
|---|---|
| `claude-code` | General-purpose coding agent that runs on Claude Code |
| `pi` | General-purpose coding agent that runs on Pi (works with many providers, for example OpenRouter) |
| `codex` | General-purpose coding agent that runs on OpenAI's Codex CLI (OpenAI models only) |
| `planner` | Writes plans and splits work into issues |
| `pr-fixer` | Fixes PRs with red CI (the default role of ci-fixer) |
| `healer` | Responds to production alerts (Sentry / Grafana) |
| `nightwatch`, `bugwatch` | Patrol agents, usually attached to a scheduled trigger |

Run lifecycle:

```text
queued → running → succeeded | failed | cancelled
```

---

## 3. Installation

### 3.1 One machine (personal)

```bash
curl -fsSL https://warren.run/install | sh
warren up
```

`warren up` selects the runtime for the machine:

- macOS: `local` with `sandbox-exec`.
- Linux with `bwrap`: `local` with `bwrap`.
- Linux without a native sandbox: prints instructions to move to Docker Compose.

The wizard asks for two credentials:

| Credential | Options |
|---|---|
| Model | **Claude subscription** (`claude setup-token` or paste `CLAUDE_CODE_OAUTH_TOKEN`), usable only with the `claude-code` harness. **Or** `ANTHROPIC_API_KEY`, usable with every harness. |
| GitHub | Short term: get it from `gh auth token` or paste a token. Long term: use a **GitHub App**, installed through the UI. |

Data lives in `~/.warren/`. Stop the server with Ctrl-C. Start it again with
`warren up`. The browser opens and is already signed in.

### 3.2 For a team (Docker Compose, Linux)

```bash
git clone https://github.com/jayminwest/warren
cd warren
cp .env.example .env
$EDITOR .env      # set secrets, ANTHROPIC_API_KEY, WARREN_GIT_AUTHOR_NAME/EMAIL
docker compose up -d
docker compose logs warren | grep mintedOperatorToken
```

Open `http://localhost:8080` and paste the token you got.

Important environment variables (see the full list in `.env.example`):

| Variable | Effect |
|---|---|
| `WARREN_RUNTIME` | `local` (default), `docker`, `k8s` |
| `WARREN_FORGE` | The default is GitHub. GitLab and Azure DevOps are also available. |
| `WARREN_DB_URL` | SQLite (default) or Postgres |
| `WARREN_AUTH` | `token` (default) or `public` (read-only access for guests) |
| `WARREN_AUTO_OPEN_PR` | When `true`, opens a PR after the push |
| `WARREN_GIT_AUTHOR_NAME` / `_EMAIL` | The agent's commit identity. Use a machine (bot) account, not a personal account. |

### 3.3 Kubernetes

Read [RUNBOOK-K8S.md](RUNBOOK-K8S.md). Each run is a pod. An admission gate
limits the number of concurrent runs and returns HTTP 429 when the limit is exceeded.

---

## 4. Register and prepare a project

### 4.1 Register

Through the UI: **Connect GitHub → Add a repo**.

Through the CLI:

```bash
warren add-project https://github.com/acme/api
warren projects            # get the project id in the form prj_xxx
```

### 4.2 Create the `.warren/` directory

```bash
warren init --project prj_xxx --default-role claude-code
```

This command creates `.warren/config.yaml` and `.warren/triggers.yaml` in the project
clone. Commit them to the repo to keep the configuration.

### 4.3 `.warren/config.yaml`: keys to know

All keys are optional. Precedence: **dispatch parameters > this file > agent frontmatter > built-in defaults.**

```yaml
defaultRole: claude-code          # default agent when the dispatch names none
defaultBranch: main
runBranchPrefix: warren           # run branch: warren/<runId>
# defaultProvider: openrouter     # only with the pi harness
# defaultModel: moonshotai/kimi-k3

# The repo's "green" check command. The agent gets it through $WARREN_QUALITY_GATE.
qualityGate: bun run check:all --bail

# USD cost cap per run. Warren checks it continuously during the run.
maxCostUsd: 5

# Repo context (8 KiB max), injected into the prompt of every agent.
# Useful when the repo has no AGENTS.md / CLAUDE.md.
repoContext: |
  pnpm monorepo. The main service is in apps/api. Run tests: pnpm test --filter api.

# Arm auto-merge for PRs that Warren opens. Off by default.
pr:
  autoMerge:
    method: squash
    protectedPaths: [".github/", "infra/"]   # do not arm when a PR touches these paths

# Fix PRs with red CI automatically.
ciFixer:
  enabled: true
  maxRetries: 3

# Applies to K8s only.
resources:
  network: restricted             # none | restricted | open
  runtimeClass: gvisor            # run the run pod on gVisor
admission:
  maxConcurrentRuns: 4
```

### 4.4 Help the agent do better work

- Add an `AGENTS.md` or `CLAUDE.md` that describes how to build, test, and the repo conventions.
- Add a fast check command, and set it in `qualityGate`.
- Optional: a `.seeds/` directory for the issue tracker, and `.mulch/` for agent memory across
  runs. Warren detects these directories when they exist.

---

## 5. Run a task

### 5.1 Dispatch

```bash
warren run -p "Fix the failing tests in apps/api" claude-code prj_xxx
```

The command dispatches the run and streams NDJSON events until the run ends. Add
`--output pretty` for easier reading.

Common flags:

| Flag | Effect |
|---|---|
| `--max-cost-usd 3` | Cost cap for this run only. It overrides all other configuration. |
| `--model <name>` / `--provider <name>` | Change the model for this run only. A `--model` alone drops a project `defaultProvider` that cannot serve it. |
| `--seed <id>` | Attach the run to a seeds issue. When the run succeeds with new commits, Warren closes the issue. |
| `--base-commit <sha>` | Cut the workspace from a fixed commit |
| `--existing-branch <branch>` | Continue work on an existing branch and push back to it. No PR opens. |
| `--new-branch <branch>` | Name the run's new branch instead of `<prefix>/<runId>`, for a repository that requires a branch name pattern. The branch must not exist yet. A PR opens as usual. |
| `--rescue-from <runId>` | Run again from the salvaged work of a failed run |

### 5.2 Monitor and intervene

```bash
warren tail run_xyz                # stream events; Ctrl-C stops only the view, the run continues
warren wait run_xyz --summary      # wait until the run ends; exit 0 on success
warren show run_xyz --summary      # state, failureReason, prUrl, costUsd
warren cancel run_xyz
```

**Steer** (send more instructions while the run executes) through the UI, or call HTTP:

```bash
curl -X POST "$WARREN_BASE_URL/runs/run_xyz/steer" \
  -H "Authorization: Bearer $WARREN_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"body": "Do not edit the migration files, only edit the tests", "priority": "high"}'
```

`priority` accepts `low`, `normal`, `high`, `urgent`.

The `pi` harness receives a steer immediately while it runs. The `claude-code` harness runs in
`--print` mode, so a steer message does **not** reach the running process. Warren only
merges that message into the prompt at the next spawn.

### 5.3 Read the result

A successful run has:

- A pushed `warren/<runId>` branch.
- A PR, if `WARREN_AUTO_OPEN_PR` is on and the branch has new commits.
- Auto-merge armed, if `pr.autoMerge` is on.

Common `failureReason` values:

| failureReason | Meaning | Fix |
|---|---|---|
| `dropped_commit` | The agent edited files but did not commit | Warren commits the uncommitted work to `warren/rescue/<runId>` (or a bundle). See the `reap.workspace_salvaged` event, or run again with `--rescue-from`. To prevent it, state "commit before you finish" in the prompt or in `AGENTS.md`. |
| `no_changes` | The run targeted an existing branch but made no commits | Check the prompt again |
| `provider_error` | The model API failed, for example out of credit | Check the key or the credit. If the code was pushed, the PR still opens. |
| `finalize_failed` | The push failed | See the `reap.workspace_salvaged` event. Run again with `--rescue-from`. |
| `push_rejected_policy` | The remote rejected the push because of a policy, for example secret scanning | Read the `reap.push_rejected` event to get the unblock link |
| infra loss (OOM, lost pod, Spot) | Infrastructure failure | Warren retries **once** automatically |

When a push fails, or the agent finishes without committing its changes, Warren saves
the work to the `warren/rescue/<runId>` branch or to a `git bundle` file, so the agent's
work is not lost.

---

## 6. Run many tasks in sequence (plan-run)

```bash
# With a plan in seeds
warren plan run pl_abc --project prj_xxx --agent claude-code --max-cost-usd 5

# Without seeds: pass an ordered list of issue ids
warren plan run --issues ISSUE-1,ISSUE-2,ISSUE-3 --project prj_xxx --agent claude-code

warren plan status <planRunId>
warren plan cancel <planRunId>
```

Warren runs the first child and waits for its PR to **merge**. Then it runs the next
child. A rerun of the same plan **resumes** from the first open issue. Use a plan-run
together with `pr.autoMerge`. Otherwise, you must merge each PR by hand.

## 7. Run on a schedule

In `.warren/triggers.yaml`:

```yaml
- id: nightly-deps
  kind: cron
  cron: '0 3 * * *'
  timezone: Asia/Ho_Chi_Minh
  role: claude-code
  prompt: |
    Update patch-level dependencies, run the tests, and push if green.
```

The scheduler checks every minute. To run a trigger now, call
`POST /projects/:id/triggers/:triggerId/run`.

> `.warren/triggers.yaml` is a protected path (Article IX). A PR that touches this
> file does not auto-merge.

## 8. Other automatic loops

| Feature | How to turn it on | Behavior |
|---|---|---|
| CI fixer | `ciFixer.enabled: true` | When a PR that Warren opened has red CI, Warren dispatches `pr-fixer` to push a fix to that PR. It has a cooldown and a retry limit. |
| Healer | `healer.enabled: true`, then point the Sentry / Grafana webhook at `POST /alerts` | When an alert maps to a project, Warren runs the `healer` agent. It has a cooldown and a retry limit. |
| Auto-merge | `pr.autoMerge` | Warren arms GitHub auto-merge after it opens the PR. It never fails the run. |
| Preview | `.warren/preview.yaml` | Starts a dev server for each run (local runtime only). See [previews.md](previews.md). |

---

## 9. Use from a script or from another agent

```bash
echo "$TOKEN" | warren login --url https://warren.example.com
warren prime          # print the full command reference, to load into the agent's context
warren doctor         # check the connection, the token, and the version
```

- The default output is NDJSON, for machines to read.
- The exit codes are stable: `0` success, `1` run failed, `2` bad arguments,
  `3` cannot connect to the server, `4` token rejected, `130` the user interrupted
  the tail (the run continues).
- Credentials are read in this order: flag > environment variable > `~/.warren/client.json`.
  The CLI does **not** read a `.env` file in the current directory.
- To use it from TypeScript, see [sdk.md](sdk.md).

CI pattern: `warren run` streams events until the run ends, and then exits. The exit code
gives the result, so CI only needs to check the exit code.

```bash
warren run -p "Update the changelog" claude-code prj_xxx > run.ndjson
echo "exit=$?"     # 0 = succeeded, 1 = failed/cancelled
```

## 10. Operations

| Task | How |
|---|---|
| Liveness / readiness | `GET /healthz`, `GET /readyz` |
| Metrics | `GET /metrics` (Prometheus) |
| Overview | The Operations page in the UI, `GET /ops/overview` |
| Cost | `GET /analytics/cost`, the Analytics page |
| Stuck run | The watchdog fails a run that is silent for more than 45 minutes. Change it with `WARREN_RUN_HEARTBEAT_TIMEOUT_MS`. |
| Warren restart | `local` runtime: running runs are marked lost. `k8s` runtime: pods keep running and are reattached at boot. |

More detail: [operations.md](operations.md), [credentials.md](credentials.md).

## 11. Current limits

- One deployment serves one operator or one team whose members trust each other.
- There is only one bearer token. There are no separate users and no RBAC.
- On the `local` runtime and the default `k8s` runtime, the model credential
  (`ANTHROPIC_API_KEY`) goes into the sandbox as an environment variable. In theory, an agent
  hit by prompt injection can read this key. See the
  [Agent Substrate integration review](design/substrate-integration.md) for
  one possible fix.

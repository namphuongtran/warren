# Claude Code model selection and credential isolation

**Kind:** architecture-decision
**Design state:** approved
**Delivery:** shipped
**Arrived:** 2026-11-21
**Shipped:** fork `namphuongtran/warren` PRs #2–#5, merged 2026-11-21
**Current truth:** `src/runtime/adapters/claude-code.ts`, `src/runtime/local/drive-prepare.ts`, `src/registry/builtins/model-tiers.ts`, `src/cli/commands/up.ts`, `docs/credentials.md`

This record covers four changes on the fork, with their reasons, limits, and verification. All four answer the same question: **which model does a `claude-code` run use, and how does it authenticate.** We found all of them when we ran Warren for real with the `docker` runtime on macOS, against a public repo, on a Claude subscription plan.

If the code and this record disagree, the code wins. The files on the `Current truth` line are the source of truth.

## Summary

| PR | Merge | Change | Problem it solves |
|---|---|---|---|
| #2 | `9309131b` | The adapter passes `--model` from the frontmatter. The agent image upgrades Claude Code from 2.1.150 to 2.1.330. | Runs used the account default model, but Warren recorded a different model on the run |
| #3 | `76d82390` | Default tiers: `claude-sonnet-5-5` and `claude-opus-5-5` | After #2, the old tiers would downgrade the model of every new install |
| #4 | `6bdb0b7a` | `warren up` exports `WARREN_DATA_DIR` and `WARREN_RUNTIME` into `process.env` | The `docker` runtime wrote workspaces to `/data` and failed with `EROFS` on macOS |
| #5 | `747784dd` | The token is no longer written into the workspace. The Keychain session copy is only a fallback. claude.ai connectors are off. | The OAuth token could be committed and then pushed to a public repo. The agent saw the connectors of the account. |

## 1. Pass `--model` to Claude Code (PR #2)

### Context

`claudeCodeAdapter.buildSpawnCommand` did not pass `--model`. Of the shipped adapters, only the `pi` adapter read `frontmatter.model`. The run row, the UI, and analytics still recorded the model of the declared tier, which was `claude-sonnet-4-6`.

Evidence: the `system/init` event of three real runs reported `model: claude-opus-4-7[1m]`, but the run row of all three recorded `claude-sonnet-4-6`.

### Decision

`claudeModelArgs(frontmatter)` adds `--model <id>` when two conditions are both true: `frontmatter.model` has a value, and the provider is empty or is `anthropic`. For other providers, the adapter drops this flag. Claude Code calls only the Anthropic API and cannot accept a model id such as an OpenRouter slug.

The agent image now uses Claude Code 2.1.330, so current model ids resolve inside the container.

### Benefits

- The model on the run row now matches the model that actually runs, so per-model analytics are meaningful.
- `WARREN_MODEL_*` and `warren run --model` now have an effect.

### Limits

- When the provider is not Anthropic, Claude Code runs the account default model. The `.warren/config.yaml` of the Warren repo itself sets `defaultProvider: openrouter`, so every `claude-code` run on the Warren repo falls into this case unless it overrides the model. A model-only override such as `--model claude-opus-5-5` drops the inherited `openrouter` provider, because the two are incompatible, and the provider comes from the agent frontmatter. Dispatch writes a `project_provider_dropped` warning event that names the dropped provider (namphuongtran/warren#43). Issue namphuongtran/warren#7 handles the recording part. Dispatch writes a `model_selection_ignored` warning event that names the provider, the ignored model, and the reason. The bridge overwrites `runs.model` with the model from the `system/init` event. The `provider` column and the cost basis still record the declared provider. The full fix is to separate the harness provider from the project provider. That work is not done.
- The Claude Code version in the image is pinned. A newer model will need another image upgrade.

## 2. Default 5.5 tiers (PR #3)

### Context

After #2, the default tier decides the model that actually runs. The two old literals, `claude-sonnet-4-6` and `claude-opus-4-8`, were older than the model that the CLI chose by itself before.

### Decision

Change the two literals in `model-tiers.ts`, which is also the only place that declares them. Update the tests and the documentation block in `.env.example`.

### Limits

Models change quickly. The literals in code will become old again, so `WARREN_MODEL_SONNET` and `WARREN_MODEL_OPUS` stay the way to change the model without a code change.

## 3. `warren up` exports the data directory (PR #4)

### Context

`runUp` set the default value of `WARREN_DATA_DIR` on a copy of the env and gave that copy to the boot step. But the runtime provider reads `process.env` directly. `DockerProvider` builds `LocalEngine` on `process.env`. As a result, every dispatch used the built-in default `/data`:

```
EROFS: read-only file system, mkdir '/data'
```

### Decision

`exportUpDefaults` exports the keys that `up` decides by itself (`WARREN_DATA_DIR`, `WARREN_RUNTIME`) into `process.env`. It sits next to the `exportStoredEnv` step, which already does the same for credentials (gh #1298). Values that the user already set stay unchanged.

### Limits

The root cause is that some seams read `process.env` instead of the boot-time env. This PR closes only the two keys that `up` sets by itself. A future key that `up` decides by itself must also go into `UP_DEFAULTED_KEYS`.

## 4. Credential and connector isolation (PR #5)

### Context: three related bugs

1. **The OAuth token was in the git checkout.** The `prepareWorkspace` step of the adapter copied the host login session (access token and refresh token, read from the macOS Keychain) into `<workspace>/.claude/.credentials.json`. The workspace is the checkout that the run pushes. The exclude list of the run did not cover this file, and `git check-ignore` confirmed that nothing ignored it. One `git add -A` from the agent was enough to commit the login session, and the finalize step would then push it to the remote. A scan of the target repo history found no committed credential. That result was luck, not design.
2. **The login session was copied even when it was not necessary.** The copy into the `$HOME` of the run still ran when the env already had `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY`, or `ANTHROPIC_AUTH_TOKEN`.
3. **claude.ai connectors loaded into runs.** With subscription auth, the CLI downloads the connectors of the account. The `system/init` event of one run listed 20 connectors (Claude Docs, Meetings, Google, Notion, Linear…), inside a process that ran with `--dangerously-skip-permissions`.

### Why bug 1 existed

| Date | Commit | Events |
|---|---|---|
| 2026-08-16 | `cba58ec5` (warren-7933) | The adapter moved over from burrow unchanged. In burrow, the bwrap sandbox set `HOME=/workspace`, so `workspace/.claude/` was HOME. This approach was correct in that context. |
| 2026-08-17 | `fda74fda` (warren-c865) | Warren moved to a private `$HOME` per run and added a copy step into HOME. The comment states the intent: resolve auth through `$HOME` *instead of* the workspace. But the old copy step in the adapter stayed. |

This was an incomplete migration, not an intentional design. The bug stayed for a long time for two reasons:

- The main environment of the project is K8s. A pod has no host Keychain, so the copy step does nothing.
- The tests checked only that the token *was* copied. No test checked that the token was *not* in the workspace.

The `commitExcludes` rule ("add the exact file when it appears in a PR") is also reactive, so it cannot catch a secret file that never leaked before.

### Decision

- **Stop writing the token into the workspace.** The run pushes the workspace, so the workspace must not contain secrets.
- **Copy the Keychain session into `$HOME` only when no other option exists.** `hasClaudeAuthEnv` checks both the profile `setEnv` and the names in the passthrough list, resolved against the host env. The `claude-code` allowlist forwards variable names, not values.
- **Set `ENABLE_CLAUDEAI_MCP_SERVERS=false`** in the spawn env. This is the documented Claude Code way to turn off connectors ("Disable claude.ai connectors"). `--strict-mcp-config` does **not** hide claude.ai connectors.
- **Last line of defense:** `commitExcludes: [".claude/.credentials.json"]`, exactly one specific path. The warren-194a rule still applies: never exclude the whole `.claude/` prefix, because target repos have real files there.
- **Recommended auth:** `claude setup-token`, then set `CLAUDE_CODE_OAUTH_TOKEN` in `~/.warren/env`. This is the documented headless method. This token can only call models and does not load connectors.

### Benefits

- No path remains for the token to get into a commit. A test stops this bug from coming back.
- When a dedicated token is present, Warren no longer copies the interactive login session of the user. That copy was in a grey area of the terms ("storing or proxying claude.ai session tokens"). It could also conflict with the host session when the token refreshes.
- The zero-config experience of the original design stays: with no token, Warren uses the fallback automatically.

### Limits

- **claude.ai connectors are off for every run.** To use connectors in a run, a per-project option to turn them back on is necessary. That work is not done.
- **The `setup-token` token expires after one year.** When it expires, runs fail at the auth step, and the operator must create a new token.
- **The fallback still leaves a copy of the login session in the `$HOME` of the run** until cleanup removes the run (the reap `terminate` step, or the periodic workspace cleanup process). This record did not verify exactly when that copy is deleted.
- **Verification scope:** real runs on the `docker` runtime on macOS. Linux with bwrap and K8s have only unit test coverage, with no real run.
- **About the terms:** one subscription user who runs Claude Code on their own machine, for their own repos, is normal personal use. If Warren serves other people (a team, or `WARREN_AUTH=public` mode with dispatch), it must move to an API key.

## Verification

| Change | Evidence |
|---|---|
| #2 | The `system/init` event reports `model: claude-sonnet-5-5`, which matches the model on the run row. New tests cover `claudeModelArgs`, with a control case for a provider that is not Anthropic. |
| #3 | 302 registry, spawn, and dispatch tests pass. `gen:docs:check` shows no change. |
| #4 | Two new tests for `runUp`. Without the fix, both fail. |
| #5 | First run after deploy: no MCP servers (20 before), no `.credentials.json` in `$HOME` or in the workspace, and `git check-ignore` confirms that git ignores the file. On the old code, the "credential in workspace" test fails on a Mac with a logged-in session, so the test reproduces the bug. |

All four PRs pass `check:all --bail` (12/12 gates) on Bun 1.3.14, the version in `.bun-version`.

## Open work

- Separate the harness provider from the project provider. After issue namphuongtran/warren#7, the run row records the correct model. But the `provider` column and the cost basis of `claude-code` runs on the Warren repo still record `openrouter`.
- A per-project option to turn on claude.ai connectors, if a real need appears.
- Run real verification for PR #5 on Linux with bwrap and on K8s.
- Propose PR #5 to the maintained fork (`luantaraschi/warren`), which can have the same bug.

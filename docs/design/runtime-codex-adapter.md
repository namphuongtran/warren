# Codex CLI harness adapter

**Kind:** architecture-decision
**Design state:** approved
**Delivery:** mixed
**Arrived:** 2026-11-21
**Current truth:** `src/runtime/adapters/codex.ts`, `src/runtime/adapters/parsers/jsonl-codex.ts`, `src/runtime/adapters/codex-pricing.ts`, `src/runtime/adapters/codex-credentials.ts`, `src/registry/builtins/codex.ts`

This record covers the third `AgentRuntimeAdapter`: OpenAI's Codex CLI, tracked as namphuongtran/warren#17. With it, a project can dispatch to a second model vendor, and cross-model review has someone to call on.

If the code and this record disagree, the code wins. The files on the `Current truth` line are the source of truth.

## Scope status

| Scope | Delivery | Evidence |
|---|---|---|
| Adapter, parser, pricing, credentials, `codex` built-in, agent images | `shipped` | Unit, golden, and bridge tests listed under Verification |
| End-to-end run on the local and Docker providers that pushes a branch | `unscheduled` | Needs a host with Codex installed and an OpenAI credential. Not yet run. |
| Fixtures captured from a live `codex exec --json` | `unscheduled` | The current fixtures are built from the 0.171.0 event schema in the Codex source, not recorded |
| ChatGPT-login runs on K8s | `not-in-core` | Pods authenticate with the `OPENAI_API_KEY` secret only |

## Context

Warren shipped two harness adapters, `claude-code` and `pi`. Neither can run OpenAI's coding agent. The issue asked for a Codex adapter that keeps every Codex-specific fact behind the adapter registry, so `check:runtime-ids` stays green.

## Decisions

### 1. Spawn: one headless turn per run

```text
sh -c '<auth shim>' codex exec --json --skip-git-repo-check \
  --dangerously-bypass-approvals-and-sandbox [--model <id>] -
```

- `codex exec --json` prints one `ThreadEvent` per line. `-` reads the prompt from stdin. Pending steering folds in after the prompt.
- `codex exec` reads stdin once and has no input channel during a turn. The adapter declares no `shouldCloseStdinOnEvent` and no `encodeSteeringMessage`, and the built-in declares `steering: "spawn-only"`. Steering therefore applies at spawn only.
- `--model` is passed only when the provider is empty or `openai`. Any other provider is reported through `ignoredModelSelection`, so dispatch records a warning event instead of dropping the selection silently.
- `--skip-git-repo-check` keeps Codex from refusing the per-run private git dir layout (warren-3c1e).

### 2. Output: normalize onto the shared `result` envelope

The parser (`jsonl-codex.ts`) maps Codex items onto the existing event kinds:

| Codex event | Warren event |
|---|---|
| `thread.started`, `turn.started` | `state_change`, verbatim |
| `agent_message` (completed) | `text` |
| `reasoning` (completed) | `thinking` |
| `command_execution`, `mcp_tool_call` | `tool_use` on start, `tool_result` on completion |
| `file_change`, `web_search` (completion only) | a `tool_use` + `tool_result` pair |
| `todo_list`, in-progress partials | `telemetry` |
| `error` item | `state_change` typed `codex.item_error` |
| top-level `error` | `state_change` typed `error`. It is not terminal, because Codex also prints reconnect notices this way. |
| `turn.completed` | `result`, `subtype: success`, `stopReason: end_turn`, priced usage |
| `turn.failed` | `result`, `is_error: true`, `stopReason: error`, `errorMessage`, `error_class` |

Tool payloads use the Anthropic content-block field names (`id`, `name`, `input`, `tool_use_id`, `is_error`, `content`, `exit_code`). The run-detail UI and the tool and file shape readers already read those names. Shell calls are named `shell`, file edits `apply_patch`, and MCP calls `mcp__<server>__<tool>`.

Mapping the turn terminals onto `result` is the main decision. The usage aggregator, the spend cap, terminal detection (local drive loop, Docker, and the K8s in-pod entrypoint), and the provider-error net all read `result` already. None of them needed a Codex branch. The adapter adds `result` to its `terminalErrorEnvelopeTypes`. claude-code's own `result` carries no `stopReason`, so the provider-error classifier still ignores it. A successful Codex turn carries `stopReason: end_turn`, which clears an earlier error.

### 3. Cost: priced from tokens

Codex reports tokens, not dollars. The parser prices `turn.completed` usage with `codex-pricing.ts`, a table copied from OpenAI's public price list. The adapter receives the run's frontmatter through a new optional `parseEvents` context argument. Pricing:

```text
(input_tokens - cached_input_tokens) × input
  + cached_input_tokens × cached input
  + output_tokens × output
```

`input_tokens` includes the cached share (OpenAI Responses API semantics), and `output_tokens` includes reasoning tokens. In the normalized envelope, `input_tokens` excludes the cached share, as claude-code's does, and `cache_read_input_tokens` carries it.

One `codex exec` runs one turn, so one `result` carries the run's whole usage. That fits the cumulative `assign` fold the `result` usage shape already uses.

### 4. Credentials

- **API key.** The sandbox allowlist forwards `OPENAI_API_KEY`, `OPENAI_BASE_URL`, and `CODEX_API_KEY` by name. `codex exec` reads `CODEX_API_KEY`. The `sh -c` shim copies `OPENAI_API_KEY` into `CODEX_API_KEY` when the latter is unset. The value moves from env to env and never appears on the argv. K8s pods get `OPENAI_API_KEY` from the existing provider registry secret.
- **ChatGPT login.** On the local and Docker providers, when no key is in the env, `forwardCodexHostCredentials` copies the host's `$CODEX_HOME/auth.json` (default `~/.codex/auth.json`) into the run's private `$HOME/.codex/auth.json` with mode 0600. The host is only read. Warren never writes the host's `config.toml`, trust entries, or hooks. The copy goes into the run's private home, never into the workspace the run pushes.

The credential hand-off is a new optional adapter hook, `forwardHostCredentials`, so `drive-prepare.ts` gains no runtime branch. The env allowlist and the binary probe list are also adapter declarations (`envPassthrough`, `cliBinaries`), read by `profile.ts` before its legacy table.

## Security

Warren's sandbox is the security boundary: bwrap, sandbox-exec, the Docker container, or the K8s pod. Codex's own sandbox (Landlock and seccomp on Linux, Seatbelt on macOS) cannot nest inside it. The argv passes `--dangerously-bypass-approvals-and-sandbox`, which Codex documents as "intended solely for running in environments that are externally sandboxed". All three providers spawn this argv inside warren's sandbox. No code path runs it on the bare host.

## Analytics and logs

- `src/core/tool-shape.ts` and `src/core/file-shape.ts` declare `codex` entries. Command mining reads `shell` commands, and the per-directory difficulty insight reads `apply_patch` paths. Codex reads files through shell commands, so file reads do not show up as file touches.
- An unpriced model leaves `total_cost_usd` off the `result` and writes `cost_unpriced_reason` on it instead, naming the model. That gap is visible in the run's event stream.
- Error envelopes carry `error_class`: `auth`, `rate_limit`, `context_overflow`, or `other`. The provider-retry classifier now treats usage limits and context overflow as durable and Codex's `stream disconnected` as transient.

## Known limits

- The spend cap trips at the end of the turn, not during it, because Codex reports usage once per turn. claude-code behaves the same way.
- An unpriced model records a cost of `$0`, because the `assign` fold reads a missing cost as zero, and the cap cannot trip. The `codex` built-in defaults to a priced model (`gpt-5.3-codex`). Add a row to `codex-pricing.ts` when a model ships.
- gpt-5.4 and gpt-5.5 bill more above a 272K-token input context. Codex reports one total per turn, so the short-context rate applies throughout and long-context runs are under-counted.
- A ChatGPT-login run uses a copy of the host's session. If Codex refreshes the token inside the run and the provider rotates the refresh token, the host's `~/.codex/auth.json` may stop working until the operator logs in again. Warren never writes the refreshed token back to the host. A long-lived install should prefer an API key.
- Steering folds into the next spawn's prompt. That spawn starts a fresh `codex exec` thread, not `codex exec resume`, so it has no memory of the earlier turn. Today the local drive loop spawns once per run, so this path is theoretical.
- `error_class` on Codex error envelopes is for operators and logs. Provider-retry decides from its own patterns in `src/runs/retry/provider-error-class.ts`, which the same messages also match. The two classifiers can drift apart; the `budget.codex.test.ts` retry cases pin the overlap.
- A ChatGPT-login run records `cost_basis: api`. Its cost is an API-priced estimate, but the cost-basis resolver reads only env vars and cannot see the login file.
- On the local provider outside the agent images, the sandbox mounts only the directory of the resolved `codex` binary and the bun global tree. A Codex install under a private Node prefix (nvm, for example) may not find its native binary inside bwrap.

## Verification

- `src/runtime/adapters/parsers/jsonl-codex.test.ts`: mapping unit tests, plus golden traces `codex-v0.171.0-tools` and `codex-v0.171.0-auth-failure` under `parsers/__golden__/`. Re-bless with `WARREN_UPDATE_CODEX_GOLDEN=1`.
- `src/runtime/adapters/codex.test.ts`: argv, the auth shim (run through a real `sh`), the model selection, steering, and the credential copy.
- `src/runs/stream/budget.codex.test.ts`: parser output through the real bridge. It covers the cap trip and cost persistence, terminal success, the provider-error capture of a 401, a reconnect followed by success, and the retry classification.
- `src/runtime/local/profile.test.ts` and `src/runtime/local/drive-prepare.test.ts` cover the env allowlist, binary resolution, and the credential hook.

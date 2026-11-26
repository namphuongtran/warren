#!/usr/bin/env bash
# Standalone Warren work queue. Runs forever (launchd: dev.warren.queue).
#
# ~/.warren/queue.tsv, one item per line, tab-separated:
#   <owner/repo>  <item>  <project-id>  <cap-usd>  [<after-issue>]
#   item         a GitHub issue number, or a path to a prompt file (read-only reviews, etc.)
#   after-issue  optional issue that must be CLOSED first: a number in the same repo, or owner/repo#n; the item
#                waits, but later runnable items do not wait behind it
# Lines starting with # are ignored. Append lines at any time; the file is re-read each loop.
#
# Lanes (2026-11-22): one worker per repo. Repos run in parallel; items of the same repo run
# one at a time, in file order, so agent PRs of one repo never race each other. The
# supervisor starts a worker for every repo in the queue file (pidfiles in ~/.warren/lanes/).
# Must stay bash 3.2 compatible: launchd runs /bin/bash.
#
# State: ~/.warren/queue.done holds "<repo>#<item>" keys already dispatched (any outcome).
# Log:   ~/.warren/logs/queue.log  (one line per start/finish).
# Pause: ~/.warren/queue.pause  (honoured by warren-gh-issue.sh before each dispatch).
# An issue item runs ~/.warren/bin/warren-gh-issue.sh, which each operator writes for their own
# repos: docs/self-host/onboard-project.md says what it must do.
set -uo pipefail
Q="$HOME/.warren/queue.tsv"; DONE="$HOME/.warren/queue.done"; LOG="$HOME/.warren/logs/queue.log"
RUNLOGS="$HOME/.warren/logs/runs"; LANES="$HOME/.warren/lanes"
mkdir -p "$RUNLOGS" "$LANES"; touch "$Q" "$DONE"
# The CLI of the deployed server tree, so the client always matches the server it calls.
WARREN=(bun run "${WARREN_CLI:-$HOME/.warren/server-src/src/cli/main.ts}")
log() { echo "$(date '+%F %T') $*" >> "$LOG"; }

issue_closed() { [ "$(gh issue view "$2" -R "$1" --json state --jq .state 2>/dev/null)" = "CLOSED" ]; }

run_prompt_file() {  # repo file project cap
  local model_args=() model
  model=$(awk -F'\t' -v k="$1#$2" '$1 == k { print $2; exit }' "$HOME/.warren/model-overrides.tsv" 2>/dev/null)
  [ -n "$model" ] && model_args=(--model "$model")
  while [ -f "$HOME/.warren/queue.pause" ]; do sleep 15; done
  "${WARREN[@]}" run --trigger "prompt-$(basename "$2" .md)" --max-cost-usd "$4" \
    ${model_args[@]+"${model_args[@]}"} -p "$(cat "$2")" claude-code "$3"
}

next_item() {  # repo -> prints the first runnable, not-done line of that repo
  local lane="$1" repo item project cap after
  while IFS=$'\t' read -r repo item project cap after; do
    [ -z "${repo:-}" ] && continue; case "$repo" in \#*) continue;; esac
    [ "$repo" = "$lane" ] || continue
    grep -qxF "$repo#$item" "$DONE" && continue
    if [ -n "${after:-}" ]; then
      case "$after" in
        *#*) issue_closed "${after%#*}" "${after#*#}" || continue ;;  # owner/repo#n in another repo
        *) issue_closed "$repo" "$after" || continue ;;
      esac
    fi
    printf '%s\t%s\t%s\t%s\n' "$repo" "$item" "$project" "$cap"; return 0
  done < "$Q"
  return 1
}

worker() {  # one lane: the items of one repo, one at a time
  local lane="$1" line repo item project cap key out run rc
  log "lane $lane started"
  while true; do
    if ! line=$(next_item "$lane"); then sleep 120; continue; fi
    IFS=$'\t' read -r repo item project cap <<< "$line"
    key="$repo#$item"; out="$RUNLOGS/$(echo "$key" | tr '/#' '__').ndjson"
    log "start $key cap=\$$cap"
    if [[ "$item" =~ ^[0-9]+$ ]]; then
      "$HOME/.warren/bin/warren-gh-issue.sh" "$repo" "$item" "$project" "$cap" > "$out" 2>&1; rc=$?
    else
      run_prompt_file "$repo" "$item" "$project" "$cap" > "$out" 2>&1; rc=$?
    fi
    run=$(grep -m1 -oE 'run_[a-z0-9]+' "$out" | head -1 || true)
    # 3 = server unreachable, 4 = token rejected (warren CLI exit codes): nothing was
    # dispatched, so keep the item pending and retry instead of marking it done.
    if [ -z "$run" ] && { [ "$rc" -eq 3 ] || [ "$rc" -eq 4 ]; }; then
      log "retry $key exit=$rc (server not ready); waiting 60s"; sleep 60; continue
    fi
    echo "$key" >> "$DONE"
    log "done  $key exit=$rc run=${run:-none}"
  done
}

log "queue started (pid $$), one lane per repo"
trap 'kill $(jobs -p) 2>/dev/null; exit 0' TERM INT
command rm -f "$LANES"/*.pid  # pids of an earlier supervisor are stale
while true; do
  for repo in $(awk -F'\t' '$1 != "" && $1 !~ /^#/ { print $1 }' "$Q" | sort -u); do
    pidfile="$LANES/$(echo "$repo" | tr '/' '_').pid"
    pid=$(cat "$pidfile" 2>/dev/null || true)
    if [ -z "$pid" ] || ! kill -0 "$pid" 2>/dev/null; then
      worker "$repo" & echo $! > "$pidfile"
    fi
  done
  sleep 60
done

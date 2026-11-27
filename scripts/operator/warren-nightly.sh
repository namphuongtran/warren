#!/usr/bin/env bash
# Dispatch the nightly acceptance workflow (launchd: dev.warren.nightly).
#
# GitHub does not fire the acceptance.yml cron on some forks (namphuongtran/warren#123), so
# launchd starts this script at 07:17 UTC instead. It runs in ~/.warren/server-src, so gh
# resolves the repository from that worktree's origin. Set WARREN_NIGHTLY_REPO=<owner/repo>
# to name it outright.
# Log: ~/.warren/logs/nightly.log
set -uo pipefail
LOG="$HOME/.warren/logs/nightly.log"
mkdir -p "$(dirname "$LOG")"
log() { echo "$(date '+%F %T') $*" >> "$LOG"; }

repo="${WARREN_NIGHTLY_REPO:-$(gh repo view --json nameWithOwner --jq .nameWithOwner 2>>"$LOG")}"
if [ -z "$repo" ]; then
  log "no repository: run from a clone of warren or set WARREN_NIGHTLY_REPO"
  exit 1
fi
if gh workflow run acceptance.yml --repo "$repo" --ref main >>"$LOG" 2>&1; then
  log "dispatched acceptance.yml on $repo"
else
  log "dispatch of acceptance.yml on $repo failed"
  exit 1
fi

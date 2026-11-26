#!/bin/bash
# warren-deploy.sh — deploy the latest warren main to the local launchd server.
# Runbook: docs/self-host/macos-launchd.md (this script automates its sections 3 and 4).
#
# Usage:
#   warren-deploy.sh                 # deploy origin/main
#   warren-deploy.sh --dry-run       # show what would deploy, change nothing
#   warren-deploy.sh --ref <sha>     # deploy (or roll back to) a specific commit
#   warren-deploy.sh --with-images   # also rebuild the base and every project agent image
#   warren-deploy.sh --yes           # skip the confirmation prompt
#
# Steps: pause queue → wait for live runs to finish → move ~/.warren/server-src
# to the ref → bun install + build:ui → [rebuild images] → kickstart server →
# verify → unpause queue. If verification fails, it rolls back to the previous
# commit and leaves the queue PAUSED for you to look at.
# bash 3.2 safe (macOS /bin/bash).

set -euo pipefail

SRC="$HOME/.warren/server-src"
PAUSE="$HOME/.warren/queue.pause"
HISTORY="$HOME/.warren/deploy-history.md"
LOG="$HOME/.warren/logs/server.log"
TOKEN_FILE="$HOME/.warren/data/operator-token"
URL="http://localhost:8080"
SVC="gui/$(id -u)/dev.warren.server"
# One directory per project image: <name>/ builds <name>-agent:latest, from its own build.sh
# when it has one (for build secrets), else from its Dockerfile.
IMAGES_DIR="$HOME/.warren/agent-images"
BASE_BUILD_ARGS=""

# Operator overrides of the values above, such as BASE_BUILD_ARGS="--build-arg WITH_BROWSER_DEPS=1"
# when a project image runs Playwright.
if [ -f "$HOME/.warren/deploy.env" ]; then
	. "$HOME/.warren/deploy.env"
fi

REF="origin/main"
DRY_RUN=0
WITH_IMAGES=0
ASSUME_YES=0

while [ $# -gt 0 ]; do
	case "$1" in
	--ref) REF="${2:?--ref needs a value}"; shift 2 ;;
	--dry-run) DRY_RUN=1; shift ;;
	--with-images) WITH_IMAGES=1; shift ;;
	--yes | -y) ASSUME_YES=1; shift ;;
	-h | --help) sed -n '2,17p' "$0"; exit 0 ;;
	*) echo "unknown argument: $1" >&2; exit 2 ;;
	esac
done

say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[33m!! %s\033[0m\n' "$*"; }
die() { printf '\033[31mxx %s\033[0m\n' "$*" >&2; exit 1; }

live_runs() { docker ps -q --filter name=warren-run- | wc -l | tr -d ' '; }

keep_rollback_tag() { # image name without tag
	if docker image inspect "$1:latest" >/dev/null 2>&1; then
		docker tag "$1:latest" "$1:pre-$OLD"
	fi
}

rebuild_project_image() { # directory under IMAGES_DIR
	local name tag
	name=$(basename "$1")
	tag="$name-agent:latest"
	keep_rollback_tag "$name-agent"
	if [ -x "$1/build.sh" ]; then
		"$1/build.sh" "$tag"
	else
		docker build -q -t "$tag" "$1"
	fi
}

build_tree() {
	(cd "$SRC" && bun install --frozen-lockfile >/dev/null && bun run build:ui >/dev/null 2>&1) ||
		return 1
}

verify_server() {
	local i boot_line
	for i in $(seq 1 45); do
		curl -sf "$URL/healthz" >/dev/null 2>&1 && break
		sleep 2
	done
	curl -sf "$URL/healthz" >/dev/null 2>&1 || { warn "healthz did not answer within 90s"; return 1; }
	curl -sf -H "Authorization: Bearer $(cat "$TOKEN_FILE")" "$URL/whoami" | grep -q '"operator"' ||
		{ warn "/whoami did not return the operator identity"; return 1; }
	pgrep -f "server-src/src/cli/main.ts up" >/dev/null ||
		{ warn "server process is not running from $SRC"; return 1; }
	boot_line=$(($(wc -l <"$LOG") - LOG_LINES_BEFORE))
	if tail -n "$boot_line" "$LOG" | grep -qE '"level":(50|60)'; then
		warn "server logged errors at boot:"
		tail -n "$boot_line" "$LOG" | grep -E '"level":(50|60)' | head -5
		return 1
	fi
	tail -n "$boot_line" "$LOG" | grep -E '"level":40' | head -5 | sed 's/^/   warn: /' || true
	return 0
}

# --- Preflight -------------------------------------------------------------
[ -d "$SRC/.git" ] || [ -f "$SRC/.git" ] || die "$SRC is not a git worktree (see docs/self-host/macos-launchd.md section 1)"
command -v docker >/dev/null || die "docker not found"
command -v bun >/dev/null || die "bun not found"

say "Fetching"
git -C "$SRC" fetch -q origin
OLD=$(git -C "$SRC" rev-parse --short HEAD)
NEW=$(git -C "$SRC" rev-parse --short "$REF^{commit}") || die "unknown ref: $REF"

echo "running : $OLD"
echo "target  : $NEW ($REF)"
if [ "$OLD" = "$NEW" ] && [ $WITH_IMAGES -eq 0 ]; then
	echo "Already on $NEW, nothing to deploy."
	exit 0
fi

echo
if git -C "$SRC" merge-base --is-ancestor "$NEW" "$OLD" && [ "$OLD" != "$NEW" ]; then
	echo "ROLLBACK — these merges will be removed:"
	git -C "$SRC" log --oneline --first-parent "$NEW..$OLD" | sed 's/^/  /' || true
else
	echo "Changes to deploy:"
	git -C "$SRC" log --oneline --first-parent "$OLD..$NEW" | sed 's/^/  /' || true
fi
DOCKER_CHANGED=$(git -C "$SRC" diff --name-only "$OLD..$NEW" -- deploy/docker/ | wc -l | tr -d ' ')
if [ "$DOCKER_CHANGED" != "0" ] && [ $WITH_IMAGES -eq 0 ]; then
	warn "deploy/docker/ changed in this range: agent images should be rebuilt."
	warn "Re-run with --with-images (or Ctrl-C now)."
fi
echo "Live runs now: $(live_runs)"

[ $DRY_RUN -eq 1 ] && { echo; echo "(dry run: nothing changed)"; exit 0; }

if [ $ASSUME_YES -eq 0 ]; then
	printf '\nDeploy %s -> %s%s? [y/N] ' "$OLD" "$NEW" "$([ $WITH_IMAGES -eq 1 ] && echo ' + rebuild images')"
	read -r answer
	case "$answer" in y | Y | yes) ;; *) echo "Aborted."; exit 1 ;; esac
fi

# From here on, any failure leaves the queue paused on purpose.
trap 'warn "Deploy stopped. The queue is still PAUSED ($PAUSE). Fix, then: rm -f $PAUSE"' ERR

# --- 1-2. Pause queue and drain ---------------------------------------------
say "Pausing queue and waiting for live runs to finish"
touch "$PAUSE"
sleep 5 # let a lane that was mid-dispatch get its container up, so we see it
while [ "$(live_runs)" != "0" ]; do
	printf '\r   %s live run(s), waiting... %s ' "$(live_runs)" "$(date +%H:%M:%S)"
	sleep 20
done
echo
echo "   no live runs"

# --- 3. Move the worktree ---------------------------------------------------
say "Checking out $NEW in $SRC"
git -C "$SRC" checkout -q --detach "$NEW"
build_tree || die "bun install / build:ui failed on $NEW (server not restarted yet; old code still running)"

# --- 4. Images (optional) ---------------------------------------------------
if [ $WITH_IMAGES -eq 1 ]; then
	say "Rebuilding agent images (old ones tagged :pre-$OLD)"
	keep_rollback_tag warren-agent
	# BASE_BUILD_ARGS is unquoted on purpose: it holds zero or more docker arguments.
	(cd "$SRC" && docker build -q -f deploy/docker/Dockerfile.agent $BASE_BUILD_ARGS -t warren-agent:latest .)
	for dir in "$IMAGES_DIR"/*/; do
		[ -d "$dir" ] || continue
		rebuild_project_image "$dir"
	done
fi

# --- 5. Restart and verify ---------------------------------------------------
say "Restarting server"
LOG_LINES_BEFORE=$(wc -l <"$LOG")
launchctl kickstart -k "$SVC"

if ! verify_server; then
	trap - ERR
	warn "Verification failed on $NEW. Rolling back to $OLD."
	git -C "$SRC" checkout -q --detach "$OLD"
	build_tree || die "rollback build failed: fix $SRC by hand. Queue stays PAUSED."
	LOG_LINES_BEFORE=$(wc -l <"$LOG")
	launchctl kickstart -k "$SVC"
	if verify_server; then
		die "Rolled back to $OLD and the server is healthy. Queue stays PAUSED until you check: rm -f $PAUSE"
	fi
	die "Rollback to $OLD did not come up healthy either. Check $LOG. Queue stays PAUSED."
fi
echo "   healthz ok, operator token ok, no boot errors"

# --- 6. Unpause --------------------------------------------------------------
trap - ERR
command rm -f "$PAUSE"
say "Queue resumed"

NOTE="Deploy script"
[ $WITH_IMAGES -eq 1 ] && NOTE="Deploy script, rebuilt agent images"
SUBJECT=$(git -C "$SRC" log -1 --format=%s "$NEW" | sed 's/|/\\|/g')
if [ ! -f "$HISTORY" ]; then
	printf '# Deploy history\n\n| Date | Commit | Note |\n|---|---|---|\n' >"$HISTORY"
fi
printf '| %s | `%s` | %s: %s |\n' "$(date +%Y-%m-%d)" "$NEW" "$NOTE" "$SUBJECT" >>"$HISTORY"

echo
echo "Deployed $OLD -> $NEW. Logged in $HISTORY."

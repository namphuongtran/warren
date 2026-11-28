# Run warren under launchd on macOS

This runbook keeps one warren server and one work queue alive on a Mac, as two launchd
services. It also tells you how to deploy a new `main` to that server and when to rebuild the
agent images. The scripts it names are in [`scripts/operator/`](../../scripts/operator/).

For a new project on this server, read [`onboard-project.md`](onboard-project.md).

## 1. Where each part lives

| Part | Location |
|---|---|
| Server code | `~/.warren/server-src`, a detached git worktree of this repository |
| Your development checkout | Any other clone. Work in progress there does not reach the server |
| Server service | `~/Library/LaunchAgents/dev.warren.server.plist` (label `dev.warren.server`) |
| Queue service | `~/Library/LaunchAgents/dev.warren.queue.plist`, which runs `~/.warren/bin/warren-queue.sh` |
| Nightly trigger | `~/Library/LaunchAgents/dev.warren.nightly.plist`, which runs `~/.warren/bin/warren-nightly.sh` (section 7) |
| Operator scripts | `~/.warren/bin/`: `warren-queue.sh`, `warren-deploy.sh`, `warren-nightly.sh`, `warren-branch-name.py`, and your own `warren-gh-issue.sh` |
| Agent images | `~/.warren/agent-images/<name>/`, one directory for each project image |
| Data (database, operator token) | `~/.warren/data` |
| Secrets | `~/.warren/env`, mode 0600 |
| Logs | `~/.warren/logs/server.log`, `queue.log`, `nightly.log`, and `runs/*.ndjson` |
| Deploy history | `~/.warren/deploy-history.md`, which the deploy script appends to |

The server reads its code only at boot. A merged pull request does not run until you restart
the server. The server runs from its own worktree, so the work in your development checkout
does not change it.

### First install

```bash
git -C <your-clone> worktree add --detach ~/.warren/server-src origin/main
(cd ~/.warren/server-src && bun install --frozen-lockfile && bun run build:ui)

mkdir -p ~/.warren/bin ~/.warren/logs
cp ~/.warren/server-src/scripts/operator/*.sh ~/.warren/server-src/scripts/operator/*.py ~/.warren/bin/
for f in ~/.warren/server-src/scripts/operator/launchd/*.plist; do
  sed "s|__HOME__|$HOME|g" "$f" > ~/Library/LaunchAgents/$(basename "$f")
done
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/dev.warren.server.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/dev.warren.queue.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/dev.warren.nightly.plist
```

Put the server secrets in `~/.warren/env` before the first boot. [`../credentials.md`](../credentials.md)
lists them.

## 2. Restart, rebuild, or both

| What the merged pull requests change | Restart the server | Rebuild images |
|---|---|---|
| Only `src/`, `docs/`, `scripts/` and similar (most changes) | Yes | No |
| `deploy/docker/Dockerfile.agent` | Yes | Yes, the base image and every project image |
| A Dockerfile in `~/.warren/agent-images/<name>/` | No | Yes, that image only |
| A tool version inside an image (Claude Code, Bun) | No | Yes |

A change in `src/` needs no image rebuild. The Docker provider runs all warren code on the
host, and the image only holds the tools of the agent. The copy of the repository in the
`/app` folder of the image is for the Kubernetes runtime only.

To find out if you must rebuild, compare the running commit with `origin/main`:

```bash
cd ~/.warren/server-src
git rev-parse --short HEAD                            # the running commit
git fetch -q origin
git log --oneline --first-parent HEAD..origin/main    # the pull requests to deploy
git diff --stat HEAD..origin/main -- deploy/docker/   # empty: no base rebuild
```

## The fast path: the deploy script

`~/.warren/bin/warren-deploy.sh` does all of section 3. With `--with-images`, it also does
section 4.

```bash
~/.warren/bin/warren-deploy.sh --dry-run        # show the pull requests to deploy, change nothing
~/.warren/bin/warren-deploy.sh                  # deploy origin/main, after a prompt
~/.warren/bin/warren-deploy.sh --with-images    # deploy and rebuild every agent image
~/.warren/bin/warren-deploy.sh --ref <sha>      # deploy, or roll back to, one commit
~/.warren/bin/warren-deploy.sh --yes            # skip the prompt
```

The script does these steps:

- It pauses the queue and waits until no run is live. Then it updates the worktree, runs
  `bun install` and `build:ui`, restarts the server, and checks it. The check reads `healthz`,
  the operator token, and the errors at boot.
- If the check fails, the script rolls back to the old commit and keeps the queue paused. Read
  the log, then resume the queue with `rm -f ~/.warren/queue.pause`.
- If the check passes, the script resumes the queue and adds one row to
  `~/.warren/deploy-history.md`.
- If `deploy/docker/` changed and you did not give `--with-images`, the script shows a warning.
- If `bun install` or `build:ui` fails, the server keeps the old code and the queue stays
  paused.

To change a value of the script on your machine, write it in `~/.warren/deploy.env`. The script
reads that file after its defaults. For example, a project image that runs Playwright needs the
browser libraries in the base image:

```bash
BASE_BUILD_ARGS="--build-arg WITH_BROWSER_DEPS=1"
```

The sections below are the manual procedure. Use them when the script fails, or to learn each
step.

## 3. Restart the server

### Step 1: Pause the queue

```bash
touch ~/.warren/queue.pause
```

Each lane reads this file before it dispatches. A lane can dispatch at the same time that you
make the file, and that run continues. So always do step 2.

### Step 2: Wait for the live runs to stop

```bash
docker ps --filter name=warren-run- --format '{{.Names}}\t{{.Status}}'
```

Wait until this command shows no rows. To let the shell wait for you:

```bash
until [ -z "$(docker ps -q --filter name=warren-run-)" ]; do sleep 20; done; echo "no live runs"
```

A restart kills each live run. Warren marks that run `lost`, and its work and cost are gone. A
`start` line in `queue.log` with no `done` line is normal: that lane waits on the pause and has
not dispatched.

### Step 3: Move the worktree to the latest main

```bash
cd ~/.warren/server-src
git fetch -q origin
git checkout --detach origin/main
bun install --frozen-lockfile
bun run build:ui
git log --oneline -1          # write down the commit you deploy
```

### Step 4: Restart the server

```bash
launchctl kickstart -k gui/$(id -u)/dev.warren.server
```

`kickstart` does not read the plist again. After you edit the plist, use these commands:

```bash
launchctl bootout gui/$(id -u)/dev.warren.server
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/dev.warren.server.plist
```

### Step 5: Check the server

```bash
# The server answers
curl -s http://localhost:8080/healthz            # {"ok":true}

# The new process runs from server-src
ps -o lstart=,command= -p $(pgrep -f "main.ts up" | head -1)

# The operator token is still valid
curl -s -H "Authorization: Bearer $(cat ~/.warren/data/operator-token)" \
  http://localhost:8080/whoami                   # "identity":"operator"

# Warnings and errors at boot (level 40 is a warning, 50 is an error)
tail -200 ~/.warren/logs/server.log | grep -E '"level":(40|50|60)'
```

### Step 6: Resume the queue

```bash
rm -f ~/.warren/queue.pause
```

After 30 to 60 seconds, `docker ps` shows the new `warren-run-*` containers.

## 4. Rebuild the agent images

Do this only when the table in section 2 tells you to. Do it after step 3, when the worktree is
on the new `main`, and before step 6, while the queue is paused.

### 4.1 Tag the old images for a rollback

```bash
SHA=$(git -C ~/.warren/server-src rev-parse --short HEAD@{1} 2>/dev/null || echo old)
docker tag warren-agent:latest warren-agent:pre-$SHA
for dir in ~/.warren/agent-images/*/; do
  img="$(basename "$dir")-agent"
  docker tag "$img:latest" "$img:pre-$SHA"
done
```

### 4.2 Build the base image first, then each project image

Build the base from `server-src`, because that tree has no work in progress.

```bash
cd ~/.warren/server-src
docker build -f deploy/docker/Dockerfile.agent -t warren-agent:latest .
```

Each directory `~/.warren/agent-images/<name>/` builds the image `<name>-agent:latest`:

```bash
docker build -t <name>-agent:latest ~/.warren/agent-images/<name>
```

When an image needs a build secret, put an executable `build.sh` in its directory. The deploy
script then runs `build.sh <name>-agent:latest` instead of `docker build`. For example:

```bash
#!/bin/sh
# Needs GITHUB_TOKEN as a build secret, so load the server secrets first.
set -a; . "$HOME/.warren/env"; set +a
exec docker build -q --secret id=gh,env=GITHUB_TOKEN -t "$1" "$(dirname "$0")"
```

A new image takes effect at the next run. An image change alone needs no server restart.

## 5. Roll back

**The server code fails after a deploy:**

```bash
touch ~/.warren/queue.pause
# wait for the live runs to stop (step 2), then:
cd ~/.warren/server-src
git checkout --detach <old-sha>        # the commit from section 2
bun install --frozen-lockfile && bun run build:ui
launchctl kickstart -k gui/$(id -u)/dev.warren.server
rm -f ~/.warren/queue.pause
```

**An image fails:**

```bash
docker tag <name>-agent:pre-<SHA> <name>-agent:latest
```

## 6. Known traps

- **Do not restart while a run is live.** Always pause, then wait for the live runs to stop.
- **Docker Desktop has one memory limit.** All its containers and other local services use it. Do not
  rebuild an image while a run is live.
- **`WARREN_GIT_AUTHOR_NAME` and `WARREN_GIT_AUTHOR_EMAIL` are safe to set.** Warren passes them
  to each run as env and never writes your `~/.gitconfig`. When both are unset, agent commits use
  `warren-agent <agent@warren.invalid>`.
- **Do not run `check:all` in a clone whose path has a space.** Seven tests fail there. Commit
  from a worktree with no space in its path.
- **`bun install` in `server-src` runs the `prepare` script, which arms the git hooks.** The hook
  path is relative (`scripts/hooks`), so your development checkout does not change.
- **A shell alias can make `rm` ask for confirmation.** In a script, write `command rm -f`.
- **Do not edit a running operator script in place.** Bash reads a script while it runs, and
  each lane that waits on the pause runs `warren-gh-issue.sh`. Edit a copy, check it with
  `bash -n`, then move the copy over the old file with `mv`.

## 7. Nightly acceptance trigger

The `Acceptance (nightly)` workflow has a cron at 07:17 UTC. GitHub did not fire that cron on the
namphuongtran/warren fork, not even a test cron every 5 minutes (namphuongtran/warren#123). The
`dev.warren.nightly` job dispatches the workflow from this Mac instead.

The job runs `~/.warren/bin/warren-nightly.sh` at 07:17 UTC each day. The script calls
`gh workflow run acceptance.yml` on the repository of `~/.warren/server-src`. It writes one line
for each attempt to `~/.warren/logs/nightly.log`.

Install the job:

```bash
cp ~/.warren/server-src/scripts/operator/warren-nightly.sh ~/.warren/bin/
sed "s|__HOME__|$HOME|g" ~/.warren/server-src/scripts/operator/launchd/dev.warren.nightly.plist \
  > ~/Library/LaunchAgents/dev.warren.nightly.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/dev.warren.nightly.plist
```

launchd reads the start time as local time. The template says 14:17, which is 07:17 UTC in UTC+7.
In another time zone, change `Hour` before you load the job.

Test the job now. You do not have to wait for the next day:

```bash
launchctl kickstart gui/$(id -u)/dev.warren.nightly
tail -1 ~/.warren/logs/nightly.log
gh run list --workflow acceptance.yml --limit 1
```

Limits:

- **The Mac must be on.** If the Mac sleeps at 07:17 UTC, launchd starts the job when it wakes. If
  the Mac is off, that day gets no nightly run.
- **`gh` needs a login that can run workflows on the repository.** The job uses the same `gh`
  login as your shell.

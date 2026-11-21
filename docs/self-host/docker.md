# Docker self-hosting

Warren supports two Docker-hosted shapes. Choose the runtime before you copy an install command.

| Shape | `WARREN_RUNTIME` | Run boundary | Agent toolchain |
|---|---|---|---|
| Compose default | `local` | `bwrap` inside the warren container | Baked into the control-plane image |
| Sibling containers | `docker` | One Docker container per run | Separate agent image |

The [first-run guide](../quickstart.md) uses the install script and `warren up`, which never touch Compose. Compose is the operator path. This guide documents both Docker shapes and the requirements that do not fit in the root README.

## Local runtime with Compose

```bash
git clone https://github.com/jayminwest/warren
cd warren
cp .env.example .env
$EDITOR .env  # set two credentials plus WARREN_GIT_AUTHOR_NAME/EMAIL
docker compose up -d
```

The Compose file pulls `ghcr.io/jayminwest/warren:latest` and mounts a named volume at `/data`. It publishes ports 8080 and 8081 and supplies four settings for nested `bwrap`:

- `apparmor=unconfined`
- `seccomp=unconfined`
- `systempaths=unconfined`
- `cap_add: SYS_ADMIN`

Remove any one of these and the local runtime cannot create its inner sandbox on Linux.

Pin `WARREN_IMAGE_TAG=v0.18.0` in `.env` for a reproducible deployment. The `latest` tag tracks the latest published image and can move.

## Sibling-container runtime

The `docker` runtime asks the host Docker daemon to start one agent container per run. The container boundary replaces nested `bwrap`, so the warren control-plane container needs no elevated security flags.

The topology has three requirements beyond the control-plane image:

1. Mount the Docker socket at `/var/run/docker.sock`.
2. A Linux Docker CLI must be executable inside the control-plane container.
3. Give the data directory the same absolute host and container path. Sibling containers bind-mount run workspaces from that path.

Build the agent image from a checkout, or supply an equivalent image:

```bash
docker build -f deploy/docker/Dockerfile.agent -t warren-agent:latest .
```

Then start warren:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
export GITHUB_TOKEN=ghp_...
export WARREN_GIT_AUTHOR_NAME=your-bot-login
export WARREN_GIT_AUTHOR_EMAIL=1234567+your-bot-login@users.noreply.github.com

docker run -d --name warren --restart unless-stopped \
  -p 8080:8080 \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v "$(command -v docker)":/usr/bin/docker:ro \
  -v /srv/warren:/srv/warren \
  -e WARREN_RUNTIME=docker \
  -e WARREN_DATA_DIR=/srv/warren \
  -e ANTHROPIC_API_KEY \
  -e GITHUB_TOKEN \
  -e WARREN_GIT_AUTHOR_NAME \
  -e WARREN_GIT_AUTHOR_EMAIL \
  ghcr.io/jayminwest/warren:v0.18.0
```

The two Git-author values are non-secret metadata. Use a dedicated machine account and its GitHub noreply address so agent commits do not inherit a personal or missing identity.

First boot creates the operator token and prints it once. Copy the `mintedOperatorToken` value, then export it for authenticated diagnostics and CLI commands:

```bash
docker logs warren | grep mintedOperatorToken
export WARREN_API_TOKEN='<mintedOperatorToken value>'
```

Open <http://localhost:8080> and paste the same token. Then dispatch the first run:

1. Open **Projects**, select **Add**, and enter the target GitHub URL.
2. Select **Dispatch run**.
3. Select an agent, enter a small task, and start the run.
4. Watch the event stream until the run reaches a terminal state.

A successful run finalizes its workspace and pushes the run branch. Warren opens a pull request when the forge and project configuration permit it.

Install the CLI when you want to dispatch from a shell:

```bash
npm i -g @os-eco/warren-cli
echo "$WARREN_API_TOKEN" | warren login --url http://localhost:8080
warren projects
```

The package requires Bun v1.1 or later because it ships raw TypeScript with a Bun shebang. Read [Credentials](../credentials.md) for the full credential picture, including the machine-account identity guidance.

Set `WARREN_DOCKER_AGENT_IMAGE` when the image is not named `warren-agent:latest`. A project-level `agentImage` in `.warren/config.yaml` overrides the deployment default and lets a repository pin a stack-specific toolchain.

`GET /readyz` runs the Docker CLI. It reports a `docker_cli` failure when the binary is absent, cannot run, or cannot reach the daemon.

## macOS Docker Desktop

The sibling-container command above targets a Linux host. Docker Desktop adds three traps.

### Docker CLI mount

The host `docker` binary often lives outside Docker Desktop's shared paths. A bind mount such as:

```bash
-v "$(command -v docker)":/usr/bin/docker:ro
```

can create an empty directory at `/usr/bin/docker` inside the container. Put a static Linux Docker CLI on the data volume and point warren at it instead:

```bash
-e WARREN_DOCKER_BIN=/srv/warren/bin/docker
```

Verify that `/readyz` reports `docker_cli` as healthy before dispatching.

### Data location

`-v /srv/warren:/srv/warren` materializes inside Docker Desktop's Linux VM, not as a normal directory on the macOS filesystem. Path parity still works for sibling containers, but inspect the data with `docker exec` or use a Desktop-shared host path deliberately.

### Stale image tags

`docker run` does not always replace a cached moving tag. Pull before startup when you use `latest`:

```bash
docker pull ghcr.io/jayminwest/warren:latest
```

A release tag avoids this ambiguity.

## Agent images

A harness needs a Warren runtime adapter and its executable must exist in the selected agent image. The shipped agent Dockerfile includes the current Pi and Claude Code harnesses plus Bun, Node, Git, Python, and `uv`.

A custom image can add another language toolchain or an operator-provided harness. An arbitrary executable does not become compatible merely because it is present in the image. Warren also needs an adapter for command construction, event parsing, steering, terminal detection, and usage extraction.

### A custom image for a project toolchain

Warren starts each run inside its agent container. The agent can run only the tools in that image. It cannot see a tool that you installed on the Docker host. When the quality gate of a project needs a toolchain that the shipped image does not have, build a project image from the shipped one.

This example is for a repository with a Python backend, a Next.js web app, and a Flutter mobile app. It adds pinned versions of all three toolchains:

```dockerfile
FROM warren-agent:latest
USER root

# Python for the backend gate. The run HOME holds the uv cache, not the image.
ENV UV_PYTHON_INSTALL_DIR=/opt/uv-python UV_LINK_MODE=copy
RUN UV_CACHE_DIR=/root/.cache/uv uv python install 3.14.2 \
    && rm -rf /root/.cache/uv && chmod -R a+rX /opt/uv-python

# pnpm for the web gate.
RUN npm install -g pnpm@10.6.0

# Flutter for the mobile gate. A git checkout, because the release archive is x64 only.
ENV FLUTTER_ROOT=/opt/flutter PATH=/opt/flutter/bin:$PATH
RUN apt-get update && apt-get install -y --no-install-recommends unzip xz-utils \
    && rm -rf /var/lib/apt/lists/* \
    && git clone --depth 1 --branch 3.44.8 https://github.com/flutter/flutter.git /opt/flutter \
    && git config --system --add safe.directory '*' \
    && flutter --disable-analytics && flutter precache --universal \
    && cd /tmp && flutter create --no-pub warm && cd warm && flutter test \
    && cd / && rm -rf /tmp/warm /root/.pub-cache \
    && chmod -R a+rwX /opt/flutter

USER bun
```

```bash
docker build -t myproject-agent:candidate ./agent-image
```

Obey these rules when you write the Dockerfile:

- **Start from the shipped agent image.** The harness executables live there. A plain language image has no Claude Code and no Pi.
- **Install every tool at build time.** Warren starts the container with a non-root `--user` and `no-new-privileges`. A run cannot use `sudo` or `apt-get`.
- **Let any uid use the tools.** Warren runs the container as the host uid, not as the image `USER`. On macOS that uid is usually 501. When the host user is root, Warren uses uid 1000. Make each directory that a tool writes to at run time writable by all users. A git checkout of an SDK also needs `safe.directory`, because the run uid does not own it.
- **Keep caches out of the image.** Warren mounts a writable home for each run and sets `HOME` to it. Per-user caches such as `~/.cache/uv` and `~/.pub-cache` go there. A cache from the build belongs to root, and the run cannot write to it.
- **Match the host architecture.** On Apple silicon, Docker builds `linux/arm64` images. Some SDKs publish Linux archives for x64 only. Use a source checkout or an arm64 build for those.
- **Load the SDK artifacts at build time.** Run one small build or test in the Dockerfile, as the Flutter step does. Then the first run does not spend its budget on downloads.
- **Keep the entrypoint transparent.** Warren does not replace the image `ENTRYPOINT`. It appends the harness command as arguments. A custom entrypoint script must end with `exec "$@"`.

### Browser tests with Playwright

A run can download a browser into its own home, but it cannot install the system libraries that the browser needs, such as `libnss3`. Without them, every Playwright spec fails at browser launch. Build the shipped image with the `WITH_BROWSER_DEPS` build argument to add those libraries:

```bash
docker build -f deploy/docker/Dockerfile.agent \
  --build-arg WITH_BROWSER_DEPS=1 -t warren-agent:latest .
```

The argument is off by default, and the default image does not change. `PLAYWRIGHT_VERSION` (default `1.62.1`) selects the Playwright release whose library list the build installs.

A project image can then install the browser at build time, at the Playwright version that the project lockfile pins. A shared `PLAYWRIGHT_BROWSERS_PATH` that every uid can read means a run does not download the browser:

```dockerfile
FROM warren-agent:latest
USER root
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright
RUN npx -y playwright@1.62.1 install chromium \
    && chmod -R a+rX /opt/ms-playwright && rm -rf /tmp/.npm
USER bun
```

When the project bumps Playwright, rebuild the image with the new version, because each Playwright release expects its own browser build.

### Test the image before you use it

Run the quality gate of the project inside the candidate image, as your host uid, against a clone of the repository:

```bash
cd /path/to/clone
docker run --rm --user "$(id -u):$(id -g)" -e HOME=/tmp/home \
  -v "$PWD":/ws -w /ws --entrypoint bash myproject-agent:candidate \
  -c 'mkdir -p "$HOME" && cd mobile && flutter pub get && flutter analyze && flutter test'
```

Compare the result with the CI result for the same commit. Some tests depend on the platform. For example, golden images that a developer rendered on macOS fail on Linux. CI often excludes such tests. Tell the agent the same thing with `repoContext` in `.warren/config.yaml`, or in the task prompt. If you do not, the agent reports these failures, or it regenerates the baselines.

### Select and replace the image

Warren selects the image for each run in this order:

1. `agentImage` in the `.warren/config.yaml` of the project.
2. The `WARREN_DOCKER_AGENT_IMAGE` variable that the warren server reads at boot.
3. The built-in default, `warren-agent:latest`.

A deployment-wide `WARREN_DOCKER_AGENT_IMAGE` applies to every project. Use `agentImage` when only one project needs the extra toolchain.

Docker resolves the tag again at each run start. To replace an image, keep the old one under a second tag and move the selected tag to the candidate:

```bash
docker tag myproject-agent:latest myproject-agent:previous
docker tag myproject-agent:candidate myproject-agent:latest
```

The next run uses the new image. A run that is already active keeps its old image. You do not have to restart warren. To roll back, move the tag back to `previous`.

## Persistence and security

The data directory contains the database, project clones, workspaces, and the minted operator token. Back it up and restrict host access.

The Docker socket grants control over the Docker daemon. Treat the warren control-plane container as trusted operator infrastructure. Do not expose the socket to agent containers.

Warren serves plain HTTP. A reverse proxy or ingress must provide TLS. Read [Security](../../SECURITY.md) before exposing an instance beyond a trusted network.

## Diagnostics

```bash
docker logs warren
docker exec warren warren doctor --local
curl http://localhost:8080/healthz
curl -H "Authorization: Bearer $WARREN_API_TOKEN" http://localhost:8080/readyz
```

See [Operations](../operations.md) for logs, probes, metrics, and incident triage.

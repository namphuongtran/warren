# Onboard a project to a launchd warren

This page adds a repository to the warren server of
[`macos-launchd.md`](macos-launchd.md) and puts its issues on the work queue.

## 1. Register the repository

```bash
bun run ~/.warren/server-src/src/cli/main.ts add-project https://github.com/<owner>/<repo>
```

The command calls `POST /projects`. Warren stores the project, clones the repository under
`~/.warren/data/projects/<owner>/<repo>`, and prints the project id (`prj_...`). Keep the id,
because the queue needs it.

The project then shows in the dashboard. Warren never adds a
repository by itself.

To list the projects again:

```bash
bun run ~/.warren/server-src/src/cli/main.ts projects
```

## 2. Build an agent image for the toolchain

The base image `warren-agent:latest` has Claude Code, Bun, Node 22, Git, Python 3 and uv. When
the gates of the repository need more, such as an SDK, a scanner or a browser, build a project
image on top of the base.

1. Make `~/.warren/agent-images/<name>/Dockerfile`, and start it with `FROM warren-agent:latest`.
2. Download the archives for the architecture of the host. Check the SHA-256 of each archive
   against the checksums file of its release.
3. End the Dockerfile with `USER bun`. Warren runs the container as the uid of the host user.
4. Build the image:

   ```bash
   docker build -t <name>-agent:latest ~/.warren/agent-images/<name>
   ```

5. Run the gates of the repository in the image before you put work on the queue:

   ```bash
   git clone --depth 1 https://github.com/<owner>/<repo> /tmp/probe
   docker run --rm --user 1000 -e HOME=/tmp/h -v /tmp/probe:/w -w /w \
     --entrypoint sh <name>-agent:latest -c 'mkdir -p $HOME; <build and test commands>'
   ```

A run has no Docker daemon. A test suite that starts containers, such as Testcontainers or
Compose, fails in a run.

You can forward a service that the host runs into the container with
`socat` in an entry point script. If you cannot, tell the agent in step 4 that the suite cannot
run.

When the repository is yours, you can keep the Dockerfile in the repository and give the image
directory a `build.sh` that builds from the clone of the project. Section 4.2 of
[`macos-launchd.md`](macos-launchd.md) describes `build.sh`.

## 3. Point the repository at the image

Add `.warren/config.yaml` to the repository and merge it to the default branch:

```yaml
agentImage: <name>-agent:latest
maxCostUsd: 10
```

Warren reads this file from its clone, and it fetches that clone before a run.
[`../design/warren-config.md`](../design/warren-config.md) lists the other keys. Until the file
is on the default branch, each run starts in the base image. For a repository that you cannot
write to, read [`../onboarding-external-repos.md`](../onboarding-external-repos.md).

## 4. Write the dispatch script

The queue runs `~/.warren/bin/warren-gh-issue.sh <owner/repo> <issue> <project-id> <cap-usd>`
for each issue item. This repository does not ship that script, because its prompt is specific
to the repositories of each operator. The script must do these things:

- Wait while `~/.warren/queue.pause` exists.
- Read the issue with `gh issue view`, and put it into a prompt.
- Call `warren run --trigger gh-issue-<n> --max-cost-usd <cap> -p <prompt> <agent> <project-id>`.
- Exit with the exit code of `warren run`. Exit code 3 or 4 means that the server did not
  answer, and the queue then tries the item again.

Add facts that the agent cannot find in the repository to the prompt, for each repository. An
example is a test suite that cannot run in the image. When a repository gates its branch names,
`warren-branch-name.py` makes a `<type>/<issue>-<slug>` name for `warren run --new-branch`.

## 5. Put the issues on the queue

Add one line for each issue to `~/.warren/queue.tsv`, with a tab between the fields:

```text
<owner>/<repo>	<issue-number>	<prj_id>	<cap-usd>	[<after-issue>]
```

- With `<after-issue>`, the item waits until that issue is closed. Write a number in the same
  repository, or `owner/repo#n`.
- An item can be the path of a prompt file in place of an issue number.
- Within one minute, the queue starts one lane for the repository. The items of one repository
  run one at a time, in file order. Different repositories run in parallel.
- To give one item its own model, add `<owner>/<repo>#<n><TAB><model>` to
  `~/.warren/model-overrides.tsv`.

Put an issue on the queue only when an agent can complete it alone. The issue has no open
decision, and the image can run its gates.

## 6. Start and watch

```bash
rm -f ~/.warren/queue.pause          # resumes every lane, not one repository
tail -f ~/.warren/logs/queue.log     # the start and done lines
ls ~/.warren/logs/runs/              # one ndjson file for each item
```

The dashboard is at <http://localhost:8080>. To log in, copy the token with
`pbcopy < ~/.warren/data/operator-token` and paste it.

To stop new dispatches, run `touch ~/.warren/queue.pause`. A live run continues.
`~/.warren/queue.done` holds each item that the queue dispatched. To run an item again, remove
its `<owner>/<repo>#<n>` line from that file.

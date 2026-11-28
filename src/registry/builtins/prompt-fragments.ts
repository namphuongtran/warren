/**
 * Shared prompt-fragment text for the built-in agents (warren-cb46,
 * plan pl-a37b).
 *
 * Builtin prompts must not assert tooling a project does not have. The
 * tracker-workflow and expertise paragraphs live in each definition's
 * `gatedPrompts` (assembled at dispatch against the project's real
 * capabilities — `src/registry/prompt-gating.ts`); the quality-gate chain
 * below is shared, always-present, and deliberately stack-neutral: it
 * never assumes `bun run check:all` on an unknown repo.
 */

import {
	RUN_APPROACH_HEADINGS,
	RUN_APPROACH_MAX_BYTES,
	RUN_APPROACH_PATH,
	RUN_HANDOFF_MAX_BYTES,
	RUN_HANDOFF_PATH,
} from "../../core/wire.ts";

/**
 * The neutral quality-gate resolution chain (warren-cb46):
 * `$WARREN_QUALITY_GATE` → CLAUDE.md / AGENTS.md → discover the project's
 * own test and lint commands.
 */
export const QUALITY_GATE_CHAIN =
	"`$WARREN_QUALITY_GATE` if set, otherwise the command documented in CLAUDE.md / AGENTS.md, otherwise discover the project's own test and lint commands (package.json scripts, Makefile targets, CI config) and run those";

/**
 * When the quality gate must run, and when it must not run again
 * (warren-7e82). Replaces the old "run it before committing and again
 * before reporting completion" wording, which made agents re-run the
 * complete gate on unchanged inputs. One green run on the final inputs
 * is still mandatory. The red-gate rule lives beside it in each
 * operating contract and is unchanged.
 */
export const GATE_FINAL_RUN_RULE =
	"Run the complete gate once on your final inputs, before or as part of your final commit (a project pre-commit hook that runs that same complete gate on those inputs counts as that run). One green run on those inputs is the completion evidence: committing or reporting completion does not by itself require another run. Rerun it only when relevant inputs changed since the last green run, to confirm the fix for a diagnosed failure, or as a bounded flake experiment you name as one.";

/**
 * Validation-discipline bullets shared by every source-editing builtin
 * (warren-7e82). Each line targets a measured waste pattern: unchanged
 * full-suite reruns to change a tail/grep filter, pipelines that hid the
 * test exit status, tests run before UI/extension dependencies were
 * installed, bare test-runner calls that bypassed configured timeouts,
 * and slow gates that kept running after a cheap static check failed.
 */
export const VALIDATION_DISCIPLINE_BULLETS = `- Validation discipline. Broad test runs are the most expensive thing you do, so never repeat one on unchanged inputs:
  - Prepare dependencies once, before the first test run: the project's install/bootstrap steps, including nested packages (UI, extensions) its tests or gate exercise.
  - Use the project's configured test entry points (package scripts, Makefile targets), which carry its timeouts and flags, rather than a bare test-runner call.
  - While iterating, run focused tests for the code you touched plus the relevant cheap static checks, not the full suite.
  - Prefer the gate's fail-fast mode when it has one (a \`--bail\` or stop-on-first-failure flag), so a cheap static failure does not wait behind a slow test or coverage step. After a failure, iterate on the failing gate or focused tests, then finish with the complete gate.
  - Capture each broad run's full output and true exit status once, for example \`<cmd> > /tmp/gate.log 2>&1; echo "exit=$?"\` (use \`set -o pipefail\` if you pipe through \`tee\`). Then search the saved log. Never re-run an unchanged command just to apply a different tail/grep filter, and never pipe a test command into tail/grep without pipefail, because the pipe hides its exit status.
  - Do not bypass project git hooks (\`--no-verify\`) to save time.`;

/** Harness-agent mulch fragment: expertise load ritual + workspace path. */
export const MULCH_FRAGMENT = `## Project expertise (mulch)

- .mulch/expertise/<domain>.jsonl holds the project's expertise records.
- Run \`ml prime\` at the start of the session to load them, and record insights worth preserving with \`ml record\` before finishing.`;

/** Harness-agent tracker fragment: the project's issue queue + sd CLI. */
export const TRACKER_FRAGMENT = `## Project issue queue (seeds)

- .seeds/issues.jsonl holds the project's issue queue.
- The \`sd\` CLI manages it (\`sd ready\`, \`sd create\`, \`sd close\`, \`sd sync\`); see AGENTS.md for the workflow.`;

/**
 * Where the workspace files are (namphuongtran/warren#158). The repository's
 * absolute path differs per runtime: K8s and the bwrap sandbox mount it at
 * /workspace, while Docker and the macOS sandbox keep the host path. Every
 * runtime starts the agent in the repository root, and reap reads the notes
 * at `join(workspacePath, RUN_*_PATH)`. So a prompt names a workspace file
 * relative to the root and never by an absolute path.
 */
export const REPO_ROOT_BULLET =
	"- Your session starts in the repository root. Every repository path this prompt names, such as .warren/agent.json, is relative to that root. Its absolute path differs between runtimes, so if you change directory, find the root again with `git rev-parse --show-toplevel`.";

/** Workspace-map bullets shared by every harness builtin (ungated). */
export const BASE_WORKSPACE_BULLETS = `${REPO_ROOT_BULLET}
- .warren/agent.json is the rendered agent definition (warren seeded it).`;

/**
 * The run closure contract (namphuongtran/warren#21), shared by every
 * builtin. Reap reads the file off the workspace, validates it against
 * `parseRunHandoff` (src/core/wire-handoff.ts), stores it with the run, and
 * renders it into the PR body. The schema below must match that validator.
 * The stop-and-ask rules (namphuongtran/warren#25) say when a blocked
 * handoff is worth an operator's answer and when the agent decides alone.
 */
export const HANDOFF_FRAGMENT = `## Handoff report (required)

Before the run ends, write your handoff report to ${RUN_HANDOFF_PATH} in the repository root, the directory your session starts in. Warren reads it after the run, stores it with the run, and shows it to the operator and in the pull request. Write it even when the work failed or you are blocked. Git ignores the file, so do not commit it. If you write it more than once, the last version counts. Keep it under ${RUN_HANDOFF_MAX_BYTES / 1024} KiB of JSON in this shape:

\`\`\`json
{
  "status": "done | partial | blocked",
  "summary": "What changed and why, in a few sentences.",
  "verification": [{ "command": "a command you ran", "outcome": "what it reported" }],
  "howToTry": ["A step a human can follow to see the change work."],
  "openQuestions": [
    {
      "question": "A decision you could not make and need a human for?",
      "options": ["One option you weighed", "Another option you weighed"],
      "recommendation": "The option you would pick, and why."
    }
  ]
}
\`\`\`

- \`status\` and \`summary\` are required. The three lists may be empty.
- \`status\` is \`done\` when the task is complete, \`partial\` when only some of it landed (say what is left in the summary), and \`blocked\` when you could not proceed (say why in \`openQuestions\`).
- List only verification commands you actually ran, with their real outcome.

### When to stop and ask

Stop with \`status: "blocked"\` and ask only when you cannot go on safely by yourself:

- The requirements are ambiguous, and each reading leads to different work.
- The next step is hard to undo: a data migration, a change to a public API or wire format, deleted data, or a rewrite of published history.
- The work needs changes beyond the scope of the task.

Otherwise, decide. Pick the option that the task and the repository's conventions support best, continue, and record the decision and its reason in your \`summary\`. A question that the code, the docs, or the tests can answer is not an open question.

For each question, list the \`options\` you weighed and give your \`recommendation\` with its reason, so the operator can accept it in one word. The operator answers in a continuation of this run, and its prompt carries the answers.`;

const [UNDERSTANDING, OPTIONS, CHOSEN, RISKS, VERIFICATION] = RUN_APPROACH_HEADINGS;

/**
 * The approach note (namphuongtran/warren#33), shared by the source-editing
 * builtins. Reap reads the file off the workspace and stores it with the run
 * (`parseRunApproach`, src/core/wire-approach.ts). The handoff report's
 * `approach` block (`parseRunHandoff`) says whether the work followed it; the
 * two examples below must validate against that parser.
 */
export const APPROACH_FRAGMENT = `## Approach note (before your first edit)

Before your first edit, write your approach to ${RUN_APPROACH_PATH} in the repository root, the directory your session starts in. Warren reads it after the run, stores it with the run, and shows it to the operator, so they can tell a deliberate design from a workaround. Git ignores the file, so do not commit it. Keep it under ${RUN_APPROACH_MAX_BYTES / 1024} KiB of Markdown under these headings:

- \`## ${UNDERSTANDING}\`: the problem in your own words, including what is out of scope.
- \`## ${OPTIONS}\`: two or three options, each with its trade-off.
- \`## ${CHOSEN}\`: the option you picked and the reason.
- \`## ${RISKS}\`: what could go wrong and what you do not know yet.
- \`## ${VERIFICATION}\`: the tests or commands that will prove the work.

A trivial task (a typo, a one-line config change) may write a one-line approach instead of the headings.

Do not rewrite the note after you start editing. If the work changes course, say so in your handoff report instead: add \`"approach": { "followed": false, "deviation": "what changed and why" }\` to it. When the work followed the note, add \`"approach": { "followed": true }\`.`;

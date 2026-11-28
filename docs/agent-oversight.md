# Review and control agent work

This guide is for the operator who reviews the work that agents do in warren.
It answers four questions:

1. Who makes each decision in a run?
2. Where does warren record what the agent decided?
3. How do you check the agent's claims against that evidence?
4. Which controls does warren enforce, and which controls must you add?

The [2026-11-28 oversight pilot](design/2026-11-28-familyroots-oversight-pilot.md) applied this guide to three real runs.
That record has the measured numbers.

## 1. Who decides what

Warren does not design and does not write code.
The agent harness (Claude Code, pi, or Codex) and its model make every design and code decision inside the sandbox.
Warren controls the frame around the run: the sandbox, the prompt, the limits, the delivery, and the record.

| Decision | Who makes it | Your lever |
|---|---|---|
| The approach, the design, the code | The agent | The repository `AGENTS.md` or `CLAUDE.md`, the issue text, `repoContext`, skills |
| The files and network the agent can reach | Warren | The runtime provider and the sandbox profile |
| The spend and the wall-clock time | Warren | `maxCostUsd`, `maxDurationMinutes` |
| Where the code goes | Warren | A run branch and a pull request. The agent never pushes. |
| Whether the change merges | You | Branch protection, required checks, review. `pr.autoMerge` is off by default. |

The strongest levers are the repository's own `AGENTS.md` or `CLAUDE.md` and the issue text.
The agent reads both before it starts.
Warren adds its built-in system prompt and the project `repoContext` from `.warren/config.yaml`.
Write the design rules that matter to you in those files.
An issue with an end state, a verification list, and an out-of-scope list gets better work than a one-line request.

## 2. What each run records

Warren keeps two kinds of record.
The agent writes some of them in its own words.
Warren derives the others from what happened.
Review the agent's words against what happened.

| Record | Source | What it says | Where to read it |
|---|---|---|---|
| Approach note, `.warren/approach.md` | The agent | The problem, the options, the choice and the reason, the risks, the verification plan | Run page, Summary tab, **Approach** card, with the handoff verdict on whether the work kept to it. `GET /runs/:id` field `approach`. Event `approach.recorded`. Not in the PR body. |
| Handoff report, `.warren/handoff.json` | The agent | `done`, `partial`, or `blocked`, a summary, the commands it ran, open questions, and whether it kept to the approach | Run page, Summary tab, **Outcome** card. `GET /runs/:id` field `handoff`. The `## Handoff` section of the PR body. |
| Event log | Warren | Each tool call with its input and its result, each steer, the cost | Run page log. `warren tail <run-id>`. `GET /runs/:id/events`. |
| Quality gate outcome | Warren | Whether the agent ran the configured `qualityGate`, and its result | Run page, **Quality** card. `GET /runs/:id` field `qualityGateOutcome`. |
| Quality flags | Warren | New lint suppressions, skipped or deleted tests, edits to protected files, `--no-verify` | Run page, **Quality** card. `GET /runs/:id` field `qualityFlags`. |
| Diff and commits | Git | The change itself | Run page, **Changes** card. The pull request. |

Warren reads the approach note and the handoff report when the run ends.
A missing or invalid file gives an `approach.missing` or a `handoff.missing` event with a reason.
Set `handoff: { required: true }` in `.warren/config.yaml` to fail a run that has no valid handoff report.

## 3. Read the approach note

Open the run in the UI at `/#/runs/<run-id>` and select the Summary tab.
The Approach card is the first card.
Under the note, it tells you if the agent kept to its plan or changed course.
The Outcome card below it shows the handoff report.

The Summary tab arrived in commit `9691b635` on 2026-11-22.
A server built before that commit has no Summary tab.
There, select the System filter of the event stream and open the `approach.recorded` row.
The `handoff.recorded` row holds the handoff report.
`GET /runs/:id` returns both fields on either build.

### The approach note is a record, not a gate

The agent writes the note and then continues to edit in the same session.
Warren reads the note after the run ends.
So you see the note after the code exists, and you cannot approve or reject it first.

"Recorded" also does not prove the order.
The agent can write the note after its first edit.
The pilot found two runs that did, and the UI showed both as recorded.
The event log is the only proof of the order.

### See the plan while the run is live

The event log shows the tool call that writes `.warren/approach.md` as it happens.
If the plan is wrong, send a steer (`POST /runs/:id/steer`, or the run page) or cancel the run (`warren cancel <run-id>`).
A steer reaches a Claude Code run at its next tool result.

### An optional approval step

Warren core has no approval gate between the plan and the code, and that is by design.
[PHILOSOPHY.md](PHILOSOPHY.md) keeps organization policy outside core.
The [campaign controller](design/campaign-controller.md) design gives operator approval to a controller, not to the run kernel.

For one run, you can still choose to approve the plan first.
The recipe uses only the existing dispatch and continuation surfaces:

1. Dispatch a plan-only run.
   Tell the agent to write the approach note, to change no files, and to end with status `blocked`.
   Ask it to copy the plan into the handoff `summary` too.
   Ask for one open question: "Approve this approach?"
2. The run then shows `needsInput`.
   Read the plan, then answer the question on the run Summary.
3. The answer form dispatches a continuation run.
   Its prompt holds the original task, the handoff summary, the question, and your answer.

The continuation prompt does not carry the approach note, and git ignores the note file.
The plan reaches the second run only through the handoff summary.
That is why step 1 asks for the copy.

Without a recorded handoff, the run shows no question to answer.
Builds before namphuongtran/warren#158 name the wrong path for both files on Docker and Local runs.
On such a build, tell the plan-only run to write them under `.warren/` at the repository root.

The recipe is a choice per run, not a project setting.
If a team needs approval on every run, the design puts that in a controller extension.
Warren does not ship one.
The blocked-run answer flow shipped in namphuongtran/warren#155.
Check that your server runs a build that includes it.

## 4. Check the claims against the log

The handoff report says what the agent did.
The event log shows what it did.
Do these checks on the runs that matter:

1. **Order.** Find the tool call that writes the approach note and the first tool call that edits a source file.
   Compare their sequence numbers.
2. **Red before green.** For a bug fix, find a test command that fails before the fix and passes after it.
   A compile error is a weak red, because it proves only that the new interface did not exist.
   A negative control is stronger: the agent reverts the fix and the test fails again.
3. **Gate results.** Find each gate command and its exit code.
   A pipe such as `cmd | grep ...` or `cmd | tail` hides the exit code.
   A chain such as `a && b && c; echo $?` gives one exit code for three steps.
   Treat both as unverified.
4. **Verification list.** Each entry in the handoff `verification` list must match a real tool call with that result.
5. **Skills.** If the note says that the agent followed a skill, look for a read of that `SKILL.md` or a `Skill` tool call.
6. **Re-run what the agent could not run.** If the agent says a tool was missing, run that tool on the pull request yourself.

The pilot did all six checks on three runs.
It found one claim that the log did not prove.
An independent re-run of the gate then confirmed that claim.

## 5. Add a third-party skill pack

A skill pack such as `mattpocock/skills` gives the agent a method, for example test-first work or a bug diagnosis loop.
Warren does not ship skill packs.
Per [PHILOSOPHY.md](PHILOSOPHY.md) Tier 0, the repository carries them.

### Commit the skills into the repository

1. Copy each skill directory to `.claude/skills/<name>/` in the target repository.
   Keep the license file next to each `SKILL.md`.
2. Claude Code inside the sandbox loads the skills from the workspace.
   To confirm, read the `skills` list in the run's `init` event.
3. A marketplace plugin that `.claude/settings.json` enables does not load in the sandbox.
   The sandbox home has no plugin cache.
   The `init` event lists only the built-in plugins.
4. The pi harness reads `.pi/skills/`.
   A warren built-in agent cannot declare skills for Claude Code yet (namphuongtran/warren#19).

### Make the agent use them

The model loads a skill only when it decides that the skill matches the task.
To make the choice predictable, name the skill for each kind of ticket in `repoContext`:

```yaml
repoContext: |
  A ticket labelled `bug`: follow the diagnosing-bugs skill. Build a command that goes red
  on this bug before you change any code, and keep it as the regression test.
  Any other ticket that changes behaviour: follow the tdd skill.
  In the approach note, name the skill you followed and the red command you ran.
```

The last line makes the choice auditable.
An instruction does not guarantee that the agent reads the skill file.
In the pilot, one of three runs read a `SKILL.md`.
A second run said that it followed a skill and never opened it.
Its behavior matched the summary in `repoContext`.

### Which skills fit a run with nobody to answer

| Fits a one-shot run | Needs a person in the session |
|---|---|
| `tdd`, `diagnosing-bugs`, `codebase-design`, `resolving-merge-conflicts` | `grilling`, `grill-me`, `prototype`, `wizard`, `teach` |

Some skills, such as `to-spec` and `triage`, set `disable-model-invocation: true`.
Only a person can start them, so they never run inside warren.

## 6. Use warren where quality control matters

Warren does not make agent output correct.
It makes the work contained, attributed, and reviewable.
Trust comes from the controls around the pull request.
The table puts each control in one of four classes.

| Class | Control | What it gives you |
|---|---|---|
| Enforced by warren | Sandbox per run | The agent reaches only its workspace and the network that the profile allows |
| Enforced by warren | Host-side push | Warren pushes a run branch and opens a pull request. Give the agent no forge credential. |
| Enforced by warren | Commit author | Every run commits as `WARREN_GIT_AUTHOR_NAME`/`_EMAIL`, or as `warren-agent <agent@warren.invalid>` when unset |
| Enforced by warren | Cost and time limits | `maxCostUsd` and `maxDurationMinutes` stop the run mid-flight |
| Enforced by warren | Merge policy | Auto-merge is off by default. Article IX paths never auto-merge. |
| Enforced by warren | Frozen definition | The run row keeps the agent definition and the prompt that it ran with |
| Derived by warren | Gate outcome, quality flags, missing notes | Warren reads the log and flags. It does not block, except `handoff.required`. |
| Written by the agent | Approach note, handoff report | Intent and claims. Check them against the log. |
| Added by you | CI with required checks, human review, a reviewer agent on a second model, the judge extension | Independent evidence |

### Gaps today

- "Recorded" does not show if the agent wrote the note before or after its first edit (namphuongtran/warren#159).
- `qualityGate` holds one command per project.
  A repository with several stacks reads `unconfigured`.
- "The gate is terminal" and "write the note first" are prompt rules, not enforcement.

### A rollout for a regulated team

1. Protect the default branch and require CI checks.
   The warren gate outcome does not replace CI.
2. Keep `pr.autoMerge` off until you have numbers.
3. Set `handoff: { required: true }` and a `qualityGate`.
4. Review in this order: the approach note, the event log for the six checks in section 4, then the diff.
5. Use the `reviewer` agent on a second model as an extra reader, and keep a human approver.
6. Measure four numbers each week.
   Count the runs with a note before the code, the claims that the log proves, the first-push CI passes, and the reverts.

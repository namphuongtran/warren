/**
 * Built-in `codex` agent definition (namphuongtran/warren#17).
 *
 * Runs OpenAI's Codex CLI through the `codex` runtime adapter
 * (`src/runtime/adapters/codex.ts`), so a project can dispatch to a second
 * model vendor with no external tooling. The operating contract matches the
 * claude-code and pi built-ins: one final green gate, commit before
 * finishing, never push.
 *
 * Article IX: this file sits under `src/registry/builtins/`, so a PR that
 * changes it needs human review and never rides auto-merge.
 */

import type { AgentDefinition } from "../schema.ts";
import { MODEL_TIERS } from "./model-tiers.ts";
import {
	BASE_WORKSPACE_BULLETS,
	GATE_FINAL_RUN_RULE,
	HANDOFF_FRAGMENT,
	MULCH_FRAGMENT,
	QUALITY_GATE_CHAIN,
	TRACKER_FRAGMENT,
	VALIDATION_DISCIPLINE_BULLETS,
} from "./prompt-fragments.ts";

const SYSTEM_BODY = `You are a helpful coding assistant. Be concise.

Workspace map:
${BASE_WORKSPACE_BULLETS}

Operating contract:
- Edit files in place.
- Quality gates are terminal, not advisory. You are NOT done until the gate exits zero. Resolve the command in this order: ${QUALITY_GATE_CHAIN}. ${GATE_FINAL_RUN_RULE} Do not declare the task complete, hand off, or end the session with a red gate — fix failures (including lint warnings, which CI treats as errors) until it is green. If the gate is genuinely unfixable in this run, say so explicitly and leave the work open rather than claiming success.
${VALIDATION_DISCIPLINE_BULLETS}
- Use git as you normally would. Commit your changes; warren reaps the branch and pushes upstream. Committing is mandatory, and staging is not committing. \`git add\` on its own leaves the work uncommitted, and reap classifies a run that ends with uncommitted changes as a FAILURE (\`dropped_commit\`) even when the agent otherwise succeeded — the workspace is then destroyed and the work is lost. Before you report completion, run \`git status\` and \`git log\` and confirm your edits are in a commit. The only exception is a run that genuinely changed no files.
- Do not run \`git push\` yourself — warren handles the push host-side after the run terminates.

${HANDOFF_FRAGMENT}
`;

export const CODEX_BUILTIN: AgentDefinition = {
	name: "codex",
	version: 1,
	sections: {
		system: SYSTEM_BODY,
		burrow_config: '[sandbox]\nnetwork = "open"\n',
	},
	gatedPrompts: { tracker: TRACKER_FRAGMENT, mulch: MULCH_FRAGMENT },
	resolvedFrom: ["builtin:codex"],
	frontmatter: {
		source: "builtin",
		tags: ["agent"],
		runtime: "codex",
		// `codex exec` reads its prompt from stdin once and has no input
		// channel during the turn, so pending steering folds into the next
		// spawn's prompt (warren-3305).
		steering: "spawn-only",
		...MODEL_TIERS.codex,
	},
};

/**
 * Per-project handoff config (namphuongtran/warren#21):
 * `handoff: { required }` in `.warren/config.yaml`.
 *
 * Every run is asked to write `.warren/handoff.json`. By default a run that
 * leaves none, or an invalid one, is only flagged (`handoff.missing` event,
 * a note in the PR body). `required: true` also fails a run that would have
 * succeeded, with failure reason `handoff_missing`.
 */

import { z } from "zod";

export const HandoffConfigSchema = z
	.object({
		required: z.boolean().default(false),
	})
	.strict();

export type HandoffConfig = z.infer<typeof HandoffConfigSchema>;

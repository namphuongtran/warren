/**
 * Needs-attention handler — `GET /attention` (namphuongtran/warren#26).
 *
 * Thin surface over `readRunAttention` (`src/runs/attention.ts`): this file
 * parses `?window=24h|7d|30d` (default `7d`) and reads the clock through the
 * frozen-clock seam. The route is `readOperator`: the list is the operator's
 * work queue, so a `WARREN_AUTH=public` spectator gets a 403, not a projection.
 */

import { readRunAttention } from "../../runs/attention.ts";
import { jsonResponse } from "../response.ts";
import type { RouteHandler, ServerDeps } from "../types.ts";
import { parseOpsWindow } from "./ops-overview.ts";

export function attentionHandler(deps: ServerDeps): RouteHandler {
	return async (ctx) => {
		const window = parseOpsWindow(ctx, "7d");
		// deps.now: the frozen-clock seam (ui-visual fixture boot, warren-010b).
		const now = deps.now?.() ?? new Date();
		return jsonResponse(200, await readRunAttention(deps.repos, { window, now }));
	};
}

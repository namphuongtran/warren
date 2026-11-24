/**
 * `GET /provider-quota` (namphuongtran/warren#30): the newest usage-window
 * report per (provider, credential fingerprint), with whether dispatch is
 * refused right now and for how long, including by the deployment's
 * utilization threshold. External queues and the UI read it to
 * wait for the reset instead of dispatching into a spent window. The
 * credential appears only as its one-way fingerprint.
 */

import type { ListProviderQuotaResponse } from "../../core/wire.ts";
import { listProviderQuota, resolveMaxUtilization } from "../../runs/quota/state.ts";
import { jsonResponse } from "../response.ts";
import type { RouteHandler, ServerDeps } from "../types.ts";

export function listQuotaHandler(deps: ServerDeps): RouteHandler {
	return async () => {
		// The deployment threshold, from the env POST /runs dispatches with.
		const maxUtilization = resolveMaxUtilization(undefined, process.env);
		const quotas = await listProviderQuota(deps.repos, deps.now?.() ?? new Date(), maxUtilization);
		const body: ListProviderQuotaResponse = { quotas };
		return jsonResponse(200, body);
	};
}

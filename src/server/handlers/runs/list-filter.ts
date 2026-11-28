/**
 * `GET /runs` query filters. `?project` and `?agent` (still exclusive of each
 * other) narrow by owner. `?gate`, `?pr`, and `?attention=1`
 * (namphuongtran/warren#39) narrow by outcome. They all filter in the query,
 * so the page, the total, and the cost rollup cover the same set.
 */

import { ValidationError } from "../../../core/errors.ts";
import {
	isRunListPrFilter,
	isRunQualityGateOutcome,
	RUN_LIST_PR_FILTERS,
	RUN_QUALITY_GATE_OUTCOMES,
} from "../../../core/wire.ts";
import type { RunListFilter } from "../../../db/repos/runs-queries.ts";

export interface RunsListQuery {
	/** The column filters; the attention ids are read separately. */
	readonly filter: Omit<RunListFilter, "ids">;
	/** `?attention=1`: keep the runs the Needs attention rules pick. Operator-only. */
	readonly attention: boolean;
}

function parseGate(raw: string | null): Pick<RunListFilter, "qualityGateOutcome"> {
	if (raw === null) return {};
	if (!isRunQualityGateOutcome(raw)) {
		throw new ValidationError(
			`?gate must be one of ${RUN_QUALITY_GATE_OUTCOMES.join(", ")}; got '${raw}'`,
		);
	}
	return { qualityGateOutcome: raw };
}

function parsePr(raw: string | null): Pick<RunListFilter, "pr"> {
	if (raw === null) return {};
	if (!isRunListPrFilter(raw)) {
		throw new ValidationError(`?pr must be one of ${RUN_LIST_PR_FILTERS.join(", ")}; got '${raw}'`);
	}
	return { pr: raw };
}

function parseAttention(raw: string | null): boolean {
	if (raw === null) return false;
	if (raw !== "1") throw new ValidationError(`?attention must be '1'; got '${raw}'`);
	return true;
}

export function parseRunsListQuery(ctx: { url: URL }): RunsListQuery {
	const params = ctx.url.searchParams;
	const project = params.get("project");
	const agent = params.get("agent");
	if (project !== null && agent !== null) {
		throw new ValidationError("filter by either ?project=... or ?agent=..., not both");
	}
	return {
		filter: {
			...(project !== null ? { projectId: project } : {}),
			...(agent !== null ? { agentName: agent } : {}),
			...parseGate(params.get("gate")),
			...parsePr(params.get("pr")),
		},
		attention: parseAttention(params.get("attention")),
	};
}

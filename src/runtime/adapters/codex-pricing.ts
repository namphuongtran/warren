/**
 * OpenAI per-token prices for the models the Codex CLI runs (namphuongtran/warren#17).
 *
 * Codex reports token counts and no cost, unlike claude-code (which reports
 * `total_cost_usd`) and pi (which reports `usage.cost.total`). Warren needs a
 * USD figure for the spend cap and the budget warning, so the Codex parser
 * prices its usage against this table.
 *
 * Source: https://developers.openai.com/api/docs/pricing, Standard tier,
 * short context, read 2026-11-21. Only rows read off that page are listed. A
 * model missing here is reported as unpriced, never guessed: the parser keeps
 * the token counts and names the model in `cost_unpriced_reason`, so the gap
 * is visible on the run's event stream. Add a row when a model ships.
 *
 * Known under-count: gpt-5.4 and gpt-5.5 bill more per token above a 272K-token
 * input context. Codex reports one usage total per turn, not per request, so
 * the long-context share cannot be recovered and the short-context rate is
 * applied throughout.
 */

/** USD per one million tokens. */
export interface CodexModelPrice {
	readonly input: number;
	readonly cachedInput: number;
	readonly output: number;
}

export const CODEX_MODEL_PRICES: Readonly<Record<string, CodexModelPrice>> = {
	"gpt-5": { input: 1.25, cachedInput: 0.125, output: 10 },
	"gpt-5-mini": { input: 0.25, cachedInput: 0.025, output: 2 },
	"gpt-5.1": { input: 1.25, cachedInput: 0.125, output: 10 },
	"gpt-5.2": { input: 1.75, cachedInput: 0.175, output: 14 },
	"gpt-5.3-codex": { input: 1.75, cachedInput: 0.175, output: 14 },
	"gpt-5.4": { input: 2.5, cachedInput: 0.25, output: 15 },
	"gpt-5.4-mini": { input: 0.75, cachedInput: 0.075, output: 4.5 },
	"gpt-5.5": { input: 5, cachedInput: 0.5, output: 30 },
	"gpt-5.6-sol": { input: 4, cachedInput: 0.4, output: 20 },
	"gpt-5.6-terra": { input: 2, cachedInput: 0.2, output: 12 },
	"gpt-5.6-luna": { input: 0.2, cachedInput: 0.02, output: 1.2 },
};

/** Token counts as Codex reports them on `turn.completed`. */
export interface CodexTokenUsage {
	/** All input tokens, cached ones included (OpenAI Responses API semantics). */
	readonly inputTokens: number;
	/** The cached subset of `inputTokens`. */
	readonly cachedInputTokens: number;
	/** All output tokens, reasoning ones included. */
	readonly outputTokens: number;
}

/** A dated snapshot id (`gpt-5.2-2026-01-15`) prices as its base model. */
const DATED_SUFFIX = /-\d{4}-\d{2}-\d{2}$/;

/** The price row for a model id, or `undefined` when the table has none. */
export function codexModelPrice(model: string | undefined): CodexModelPrice | undefined {
	const id = model?.trim().toLowerCase();
	if (id === undefined || id === "") return undefined;
	return CODEX_MODEL_PRICES[id] ?? CODEX_MODEL_PRICES[id.replace(DATED_SUFFIX, "")];
}

/** USD for one usage reading, or `null` when the model has no price row. */
export function codexCostUsd(model: string | undefined, usage: CodexTokenUsage): number | null {
	const price = codexModelPrice(model);
	if (price === undefined) return null;
	const cached = Math.min(usage.cachedInputTokens, usage.inputTokens);
	const uncached = usage.inputTokens - cached;
	return (
		(uncached * price.input + cached * price.cachedInput + usage.outputTokens * price.output) /
		1_000_000
	);
}

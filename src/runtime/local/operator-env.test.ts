import { describe, expect, test } from "bun:test";
import { operatorEnvPassthrough, withOperatorEnvPassthrough } from "./operator-env.ts";

describe("operatorEnvPassthrough", () => {
	test("returns nothing when the variable is unset or blank", () => {
		expect(operatorEnvPassthrough({})).toEqual([]);
		expect(operatorEnvPassthrough({ WARREN_AGENT_ENV_PASSTHROUGH: "  " })).toEqual([]);
	});

	test("splits on commas and whitespace and drops duplicates", () => {
		expect(
			operatorEnvPassthrough({
				WARREN_AGENT_ENV_PASSTHROUGH: "NODE_AUTH_TOKEN, NPM_TOKEN NODE_AUTH_TOKEN",
			}),
		).toEqual(["NODE_AUTH_TOKEN", "NPM_TOKEN"]);
	});

	test("skips entries that are not env names", () => {
		expect(operatorEnvPassthrough({ WARREN_AGENT_ENV_PASSTHROUGH: "OK_1,1BAD,a-b,$X,=Y" })).toEqual(
			["OK_1"],
		);
	});
});

describe("withOperatorEnvPassthrough", () => {
	test("appends the operator names the base list lacks", () => {
		expect(
			withOperatorEnvPassthrough(["ANTHROPIC_API_KEY"], {
				WARREN_AGENT_ENV_PASSTHROUGH: "ANTHROPIC_API_KEY,NODE_AUTH_TOKEN",
			}),
		).toEqual(["ANTHROPIC_API_KEY", "NODE_AUTH_TOKEN"]);
	});

	test("returns a copy of the base list when the variable is unset", () => {
		const base = ["CLAUDE_CODE_OAUTH_TOKEN"];
		const out = withOperatorEnvPassthrough(base, {});
		expect(out).toEqual(base);
		expect(out).not.toBe(base);
	});
});

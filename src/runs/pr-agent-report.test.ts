import { describe, expect, test } from "bun:test";
import { PREVIEW_FRAGMENT_START } from "./pr.ts";
import { composeBody, type PrFragmentContext } from "./pr-template.ts";

const BASE_CTX: PrFragmentContext = {
	prompt: "do x",
	runId: "run_abc",
	agentName: "refactor-bot",
};

/** The `## Agent report` section alone, up to the next body section. */
function reportSection(body: string): string {
	const start = body.indexOf("## Agent report");
	if (start === -1) throw new Error("no ## Agent report section");
	const next = body.indexOf("\n## Run", start);
	return (next === -1 ? body.slice(start) : body.slice(start, next)).trimEnd();
}

describe("composeBody agent_report fragment (namphuongtran/warren#42)", () => {
	test("caps an oversized message at 8 KiB, keeping its start and its end", () => {
		const message = `HEAD-${"x".repeat(10_000)}-MIDDLE-${"y".repeat(10_000)}-TAIL`;
		const section = reportSection(composeBody({ ...BASE_CTX, agentReport: message }));
		expect(section).toContain("HEAD-");
		expect(section).toContain("-TAIL");
		expect(section).not.toContain("-MIDDLE-");
		expect(section).toContain("Truncated");
		expect(new TextEncoder().encode(section).length).toBeLessThan(8 * 1024 + 512);
	});

	test("never splits a multi-byte character at the cap", () => {
		const section = reportSection(composeBody({ ...BASE_CTX, agentReport: "é".repeat(10_000) }));
		expect(section).not.toContain("�");
		expect(section).toContain("Truncated");
	});

	test("leaves a message under the cap untouched, with no truncation note", () => {
		const section = reportSection(composeBody({ ...BASE_CTX, agentReport: "All done." }));
		expect(section).toContain("All done.");
		expect(section).not.toContain("Truncated");
	});

	test("fences a message holding a code fence so it cannot close the section early", () => {
		const message = "Ran:\n```ts\nconst a = 1;\n```\n\n## Not a PR section";
		const section = reportSection(composeBody({ ...BASE_CTX, agentReport: message }));
		expect(section).toBe(`## Agent report\n\n\`\`\`\`text\n${message}\n\`\`\`\``);
	});

	test("outgrows the longest backtick run in the message", () => {
		const message = "five: ````` end";
		const section = reportSection(composeBody({ ...BASE_CTX, agentReport: message }));
		expect(section).toBe(`## Agent report\n\n\`\`\`\`\`\`text\n${message}\n\`\`\`\`\`\``);
	});

	test("keeps a quoted preview marker from hijacking the preview annotator", () => {
		const body = composeBody({
			...BASE_CTX,
			previewOptedIn: true,
			agentReport: `I saw ${PREVIEW_FRAGMENT_START} in the template.`,
		});
		expect(body.indexOf(PREVIEW_FRAGMENT_START)).toBeGreaterThan(body.indexOf("## Preview"));
	});
});

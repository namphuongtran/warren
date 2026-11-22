import { describe, expect, test } from "bun:test";

import { KNOWN_RUNTIME_IDS } from "../../core/wire.ts";
import { claudeCodeAdapter } from "./claude-code.ts";
import {
	adapterFor,
	allAdapters,
	harnessStatePrefixes,
	keepAliveEnvelopeTypes,
	providerErrorEnvelopeTypes,
	RUNTIME_ADAPTERS,
} from "./index.ts";

describe("adapter registry (warren-c80e)", () => {
	test("declares exactly one adapter per known runtime id, keyed by its own id", () => {
		expect(Object.keys(RUNTIME_ADAPTERS).sort()).toEqual([...KNOWN_RUNTIME_IDS].sort());
		for (const id of KNOWN_RUNTIME_IDS) {
			// A copy-paste that leaves the wrong id on an adapter would make
			// `adapterFor` silently answer for another harness.
			expect(adapterFor(id).runtimeId).toBe(id);
		}
		expect(allAdapters()).toHaveLength(KNOWN_RUNTIME_IDS.length);
	});

	test("every declared prefix is directory-shaped or an exact filename (warren-8dc8)", () => {
		// The consumers match with `startsWith`. Entries fall into two valid shapes:
		//   1. Directory prefix (ends with '/') — the trailing slash prevents accidentally
		//      swallowing siblings (e.g. '.claude' without slash would also match '.claude.json').
		//   2. Exact filename (no slash, contains a dot extension) — precise enough that
		//      startsWith won't swallow unrelated siblings. Used when the harness writes a
		//      sibling file rather than a directory (warren-8dc8: '.claude.json' is a sibling
		//      of '.claude/', not inside it, so the directory prefix alone does not cover it).
		// A bare name with no extension and no trailing slash is the dangerous form and is rejected.
		for (const adapter of allAdapters()) {
			for (const prefix of adapter.harnessStatePrefixes) {
				expect(prefix.startsWith("/")).toBe(false);
				const isDirectory = prefix.endsWith("/");
				const isExactFile = prefix.includes(".");
				expect(isDirectory || isExactFile).toBe(true);
			}
		}
	});
});

describe("what the seam must not lose (warren-c80e)", () => {
	test("the harness-state union still carries the pre-seam claude-code prefix", () => {
		// `HARNESS_STATE_PREFIXES` was the flat literal `[".claude/"]`. Whatever
		// else the registry gains, dropping this one would re-arm the
		// dropped-commit guard against claude-code's own scratch (warren-f6f2).
		expect(harnessStatePrefixes()).toContain(".claude/");
	});

	test("the provider-error union is pi's pair plus the shared result envelope", () => {
		// warren-edc3 read `turn_end` and `agent_end` and nothing else. A new
		// type has to come here and say why. namphuongtran/warren#17: Codex normalizes
		// `turn.failed` onto `result` with `stopReason: "error"`. claude-code's
		// own `result` carries no `stopReason`, so the classifier still ignores
		// every claude-code envelope, as it did before.
		expect([...providerErrorEnvelopeTypes()].sort()).toEqual(["agent_end", "result", "turn_end"]);
	});

	test("pi contributes its transcript dir but NOT the composition dirs above it", () => {
		// `.pi/skills/` and `.pi/prompts/` are written by warren from the agent
		// definition, not by the harness. Listing the bare `.pi/` parent would
		// make the dropped-commit guard ignore warren's own composition output.
		const pi = adapterFor("pi");
		expect(pi.harnessStatePrefixes).toEqual([".pi/sessions/"]);
		expect(pi.harnessStatePrefixes).not.toContain(".pi/");
	});

	test("a runtime with nothing to declare says so with an empty list", () => {
		// Empty is a claim backed by the per-adapter doc comment, never an
		// accidental hole: `undefined` would type-error at the interface.
		expect(adapterFor("claude-code").terminalErrorEnvelopeTypes).toEqual([]);
	});
});

describe("keepAliveEnvelopeTypes (namphuongtran/warren#83)", () => {
	test("covers the payload type the claude-code parser stores for a tool_progress line", () => {
		const line = JSON.stringify({
			type: "tool_progress",
			tool_use_id: "toolu_016v62cYWga7ttHSxU7F6Qkt",
			tool_name: "Bash",
			parent_tool_use_id: null,
			elapsed_time_seconds: 678,
			heartbeat: true,
		});
		const events = claudeCodeAdapter.parseEvents?.(line) ?? [];
		expect(events).toHaveLength(1);
		const payloadType = (events[0]?.payload as { type?: unknown } | undefined)?.type;
		expect(payloadType).toBe("tool_progress");
		expect(keepAliveEnvelopeTypes()).toContain("tool_progress");
	});

	test("leaves the claude-code activity events counted", () => {
		const assistant = JSON.stringify({
			type: "assistant",
			message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }] },
		});
		const types = (claudeCodeAdapter.parseEvents?.(assistant) ?? []).map(
			(e) => (e.payload as { type?: unknown }).type,
		);
		expect(types).toEqual(["tool_use"]);
		expect(keepAliveEnvelopeTypes()).not.toContain("tool_use");
	});
});

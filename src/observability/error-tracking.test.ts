import { describe, expect, test } from "bun:test";
import {
	initErrorTracking,
	NOOP_ERROR_TRACKER,
	scrubSentryEvent,
	withoutChannelIntegrations,
} from "./error-tracking.ts";

describe("withoutChannelIntegrations", () => {
	test("drops the framework error integrations and keeps the rest", () => {
		const names = ["Express", "Http", "Hono", "OnUncaughtException", "Koa", "BunServer"];
		const kept = withoutChannelIntegrations(names.map((name) => ({ name })));
		expect(kept.map((i) => i.name)).toEqual(["Http", "OnUncaughtException", "BunServer"]);
	});
});

// Real Sentry init runs in a child process: it installs process-wide
// uncaught-exception handlers that must not leak into the test runner.
describe("initErrorTracking with a DSN", () => {
	test("boots without a Sentry console warning and keeps crash capture", async () => {
		const modulePath = `${import.meta.dir}/error-tracking.ts`;
		const script = [
			`const { initErrorTracking } = await import(${JSON.stringify(modulePath)});`,
			`const { tracker } = await initErrorTracking({ SENTRY_DSN: "http://k@127.0.0.1:9/1" });`,
			`const Sentry = await import("@sentry/bun");`,
			`const names = Sentry.getClient()?.getOptions().integrations.map((i) => i.name) ?? [];`,
			"console.log(JSON.stringify({ enabled: tracker.enabled, names }));",
			"process.exit(0);",
		].join("\n");
		const proc = Bun.spawn(["bun", "-e", script], { stdout: "pipe", stderr: "pipe" });
		const [stdout, stderr, code] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		expect(stderr).not.toContain("[Sentry]");
		expect(code).toBe(0);
		const out = JSON.parse(stdout.trim()) as { enabled: boolean; names: string[] };
		expect(out.enabled).toBe(true);
		expect(out.names).toContain("OnUncaughtException");
		expect(out.names).toContain("OnUnhandledRejection");
		expect(out.names).not.toContain("Express");
	});
});

describe("initErrorTracking", () => {
	test("returns the no-op tracker when SENTRY_DSN is unset", async () => {
		const { tracker, environment } = await initErrorTracking({});
		expect(tracker.enabled).toBe(false);
		expect(tracker).toBe(NOOP_ERROR_TRACKER);
		expect(environment).toBe("production");
	});

	test("blank DSN is treated as unset", async () => {
		const { tracker } = await initErrorTracking({ SENTRY_DSN: "   " });
		expect(tracker.enabled).toBe(false);
	});

	test("resolves the environment override without a DSN", async () => {
		const { environment } = await initErrorTracking({ SENTRY_ENVIRONMENT: "staging" });
		expect(environment).toBe("staging");
	});

	test("no-op tracker capture methods are safe to call", async () => {
		const { tracker } = await initErrorTracking({});
		expect(() => tracker.captureException(new Error("x"))).not.toThrow();
		expect(() => tracker.captureMessage("y")).not.toThrow();
		await expect(tracker.flush()).resolves.toBeUndefined();
	});
});

describe("scrubSentryEvent", () => {
	test("redacts secret-shaped fields in extra", () => {
		const event = scrubSentryEvent({
			extra: { token: "abc", githubToken: "ghp_x", runId: "r1", AUTHORIZATION: "Bearer z" },
		});
		expect(event.extra).toEqual({
			token: "[Redacted]",
			githubToken: "[Redacted]",
			runId: "r1",
			AUTHORIZATION: "[Redacted]",
		});
	});

	test("redacts request header secrets", () => {
		const event = scrubSentryEvent({
			request: { headers: { authorization: "Bearer t", "content-type": "application/json" } },
		});
		expect((event.request as { headers: Record<string, string> }).headers).toEqual({
			authorization: "[Redacted]",
			"content-type": "application/json",
		});
	});

	test("redacts secrets nested one level deep in extra", () => {
		const event = scrubSentryEvent({
			extra: { config: { token: "abc", host: "example.com" }, runId: "r1" },
		});
		expect(event.extra).toEqual({
			config: { token: "[Redacted]", host: "example.com" },
			runId: "r1",
		});
	});

	test("redacts secrets nested one level deep in request headers", () => {
		const event = scrubSentryEvent({
			request: { headers: { meta: { authorization: "Bearer t" }, "content-type": "text/plain" } },
		});
		expect((event.request as { headers: Record<string, unknown> }).headers).toEqual({
			meta: { authorization: "[Redacted]" },
			"content-type": "text/plain",
		});
	});

	test("leaves events without extra/request untouched", () => {
		const event = scrubSentryEvent({ message: "hello" });
		expect(event).toEqual({ message: "hello" });
	});
});

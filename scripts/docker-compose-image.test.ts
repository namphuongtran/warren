import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { load } from "js-yaml";

// Guards for warren-26be: docker-compose.yml must pull the published
// control-plane image rather than build from source, so a fresh clone
// self-hosts without a local build. The workflow that published the image
// (deploy-gke.yml) left this fork in namphuongtran/warren#109.

const REPO_ROOT = resolve(import.meta.dir, "..");

describe("docker-compose.yml pulls the published image", () => {
	const raw = readFileSync(resolve(REPO_ROOT, "docker-compose.yml"), "utf8");
	const parsed = load(raw) as {
		services?: Record<string, { image?: string; build?: unknown }>;
	};

	test("the warren service names the ghcr.io image with an overridable tag", () => {
		const image = parsed.services?.warren?.image ?? "";
		expect(image.startsWith("ghcr.io/jayminwest/warren:")).toBe(true);
		// Self-hosters pin a release without editing the file.
		expect(image).toContain("WARREN_IMAGE_TAG");
	});

	test("no active build block — a fresh clone pulls rather than builds", () => {
		expect(parsed.services?.warren?.build).toBeUndefined();
		// The fallback stays in the file, commented, for contributors.
		expect(raw).toContain("# build:");
		expect(raw).toContain("#   dockerfile: Dockerfile");
	});
});

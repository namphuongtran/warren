import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { defaultSpawn } from "./clone.ts";
import { ProjectUnavailableError } from "./errors.ts";
import { createGitFixture, type GitFixture } from "./git-fixture.test-helpers.ts";
import { refreshProjectClone } from "./refresh.ts";

/**
 * namphuongtran/warren#169: a dispatch cut from a non-default base names it
 * through `fetchRef`. The shared clone still lands on the default-branch tip,
 * so every later reader of the clone sees the default branch. The base is
 * brought to origin's tip as a local ref and never checked out.
 */

const BRANCH = "feature/x";

describe("refreshProjectClone: a non-default base (namphuongtran/warren#169)", () => {
	let fixture: GitFixture;
	beforeEach(() => {
		fixture = createGitFixture();
	});
	afterEach(() => {
		fixture.cleanup();
	});

	function refresh(fetchRef: string) {
		return refreshProjectClone({
			config: { root: fixture.dir, gitBinary: "git" },
			localPath: fixture.clone,
			ref: "main",
			fetchRef,
			spawn: defaultSpawn,
		});
	}

	function headOf(ref: string): string {
		return fixture.git(fixture.clone, "rev-parse", ref);
	}

	test("brings a remote branch to origin's tip and leaves the clone on the default-branch tip", async () => {
		const stale = fixture.commitToOrigin({ "a.txt": "1\n" });
		fixture.pushBranch(BRANCH, stale);
		fixture.git(fixture.clone, "fetch", "-q", "origin");
		fixture.git(fixture.clone, "branch", BRANCH, `origin/${BRANCH}`);
		const branchTip = fixture.commitToOrigin({ "a.txt": "2\n" });
		fixture.pushBranch(BRANCH, branchTip);
		const mainTip = fixture.commitToOrigin({ ".warren/config.yaml": "qualityGate: make check\n" });

		const result = await refresh(BRANCH);

		expect(result.headSha).toBe(mainTip);
		expect(result.baseSha).toBe(branchTip);
		expect(result.ref).toBe(BRANCH);
		expect(fixture.git(fixture.clone, "symbolic-ref", "HEAD")).toBe("refs/heads/main");
		expect(headOf(`refs/heads/${BRANCH}`)).toBe(branchTip);
	});

	test("moves the clone back to the default branch when an older refresh left it on the base", async () => {
		const branchTip = fixture.commitToOrigin({ "a.txt": "1\n" });
		fixture.pushBranch(BRANCH, branchTip);
		fixture.git(fixture.clone, "fetch", "-q", "origin");
		fixture.git(fixture.clone, "checkout", "-q", "-b", BRANCH, `origin/${BRANCH}`);
		const mainTip = fixture.commitToOrigin({ "b.txt": "1\n" });

		await refresh(BRANCH);

		expect(fixture.git(fixture.clone, "symbolic-ref", "HEAD")).toBe("refs/heads/main");
		expect(headOf("HEAD")).toBe(mainTip);
		expect(headOf(`refs/heads/${BRANCH}`)).toBe(branchTip);
	});

	test("resolves a tag base without creating a local branch", async () => {
		const tagged = fixture.commitToOrigin({ "a.txt": "1\n" });
		fixture.git(fixture.origin, "tag", "v1", tagged);
		fixture.commitToOrigin({ "b.txt": "1\n" });

		const result = await refresh("v1");

		expect(result.baseSha).toBe(tagged);
		expect(fixture.git(fixture.clone, "branch", "--list", "v1")).toBe("");
	});

	test("aborts before any checkout when origin does not carry the base", async () => {
		const before = headOf("HEAD");
		fixture.commitToOrigin({ "a.txt": "1\n" });

		await expect(refresh("feature/missing")).rejects.toBeInstanceOf(ProjectUnavailableError);
		expect(headOf("HEAD")).toBe(before);
	});
});

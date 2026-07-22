import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import {
  getWorkspaceGitDiffAsync,
  getWorkspaceGitStatusDataAsync,
} from "./workspace-git-utils";

describe("workspace branch comparison", () => {
  let repoRoot: string;

  const git = (...args: string[]) => {
    execFileSync("git", args, { cwd: repoRoot, stdio: "ignore" });
  };

  beforeEach(() => {
    repoRoot = mkdtempSync(path.join(os.tmpdir(), "rah-branch-comparison-"));
    git("init");
    git("config", "user.name", "RAH Test");
    git("config", "user.email", "rah@example.com");
    git("branch", "-M", "main");
    writeFileSync(path.join(repoRoot, "base.txt"), "base\n", "utf8");
    writeFileSync(path.join(repoRoot, "worktree.txt"), "clean\n", "utf8");
    git("add", ".");
    git("commit", "-m", "base");
    git("update-ref", "refs/remotes/origin/main", "HEAD");

    git("switch", "-c", "feature/readable-changes");
    writeFileSync(path.join(repoRoot, "first.txt"), "first branch change\n", "utf8");
    git("add", ".");
    git("commit", "-m", "first feature change");
    git("branch", "checkpoint");
    writeFileSync(path.join(repoRoot, "second.txt"), "second branch change\n", "utf8");
    git("add", ".");
    git("commit", "-m", "second feature change");

    writeFileSync(path.join(repoRoot, "worktree.txt"), "local worktree change\n", "utf8");
    writeFileSync(path.join(repoRoot, "untracked.txt"), "new local file\n", "utf8");
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  test("defaults to all uncommitted changes relative to the checked-out branch", async () => {
    const status = await getWorkspaceGitStatusDataAsync(repoRoot);
    const untrackedDiff = await getWorkspaceGitDiffAsync(repoRoot, "untracked.txt", {
      baseBranch: "feature/readable-changes",
    });

    assert.equal(status.branch, "feature/readable-changes");
    assert.equal(status.baseBranch, "feature/readable-changes");
    assert.equal(status.comparisonMode, "uncommitted");
    assert.match(status.comparisonBase ?? "", /^[0-9a-f]{40}$/);
    assert.deepEqual(
      status.branchFiles.map((file) => file.path).sort(),
      ["untracked.txt", "worktree.txt"],
    );
    assert.deepEqual(
      status.unstagedFiles.map((file) => file.path).sort(),
      ["untracked.txt", "worktree.txt"],
    );
    assert.ok(status.branchOptions.includes("main"));
    assert.ok(status.branchOptions.includes("origin/main"));
    assert.ok(status.branchOptions.includes("feature/readable-changes"));
    assert.ok(!status.branchOptions.includes("origin"));
    assert.match(untrackedDiff, /new file mode/);
    assert.match(untrackedDiff, /\+new local file/);
  });

  test("recomputes the current worktree diff from a selected ancestor", async () => {
    const status = await getWorkspaceGitStatusDataAsync(repoRoot, {
      baseBranch: "checkpoint",
    });
    const diff = await getWorkspaceGitDiffAsync(repoRoot, "second.txt", {
      baseBranch: "checkpoint",
    });

    assert.equal(status.baseBranch, "checkpoint");
    assert.equal(status.comparisonMode, "merge_base");
    assert.deepEqual(
      status.branchFiles.map((file) => file.path).sort(),
      ["second.txt", "untracked.txt", "worktree.txt"],
    );
    assert.match(diff, /second branch change/);
    assert.doesNotMatch(diff, /first branch change/);
  });

  test("uses the shared ancestor instead of the selected branch tip", async () => {
    git("stash", "push", "--include-untracked", "-m", "local test changes");
    git("switch", "main");
    writeFileSync(path.join(repoRoot, "main-only.txt"), "advanced only on main\n", "utf8");
    git("add", ".");
    git("commit", "-m", "advance main after feature split");
    git("switch", "feature/readable-changes");
    git("stash", "pop");

    const status = await getWorkspaceGitStatusDataAsync(repoRoot, {
      baseBranch: "main",
    });

    assert.equal(status.comparisonMode, "merge_base");
    assert.deepEqual(
      status.branchFiles.map((file) => file.path).sort(),
      ["first.txt", "second.txt", "untracked.txt", "worktree.txt"],
    );
    assert.ok(!status.branchFiles.some((file) => file.path === "main-only.txt"));
  });
});

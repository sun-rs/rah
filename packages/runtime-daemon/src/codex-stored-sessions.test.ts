import { afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import {
  applyCodexGitFileAction,
  applyCodexGitHunkAction,
  createCodexStoredSessionFrozenHistoryPageLoader,
  getCodexGitDiff,
  getCodexGitStatus,
  readWorkspaceFile,
  type CodexStoredSessionRecord,
} from "./codex-stored-sessions";

function timelineTexts(
  events: Array<{
    type: string;
    payload: { item?: { kind?: string; text?: string } } | Record<string, unknown>;
  }>,
): string[] {
  return events.flatMap((event) => {
    if (event.type !== "timeline.item.added") {
      return [];
    }
    const item = "item" in event.payload ? (event.payload.item as { kind?: string; text?: string } | undefined) : undefined;
    if (item?.kind === "user_message" || item?.kind === "assistant_message") {
      return [item.text ?? ""];
    }
    return [];
  });
}

describe("codex stored session path resolution", () => {
  let repoRoot: string;
  let sessionCwd: string;
  let targetRelativePath: string;
  let outsideRelativePath: string;

  beforeEach(() => {
    repoRoot = mkdtempSync(path.join(os.tmpdir(), "rah-codex-stored-session-"));
    sessionCwd = path.join(repoRoot, "crates", "solars-time");
    targetRelativePath = path.join("crates", "solars-time", "src", "lib.rs");
    outsideRelativePath = path.join("crates", "solars-ctp-feed", "src", "app", "config.rs");

    mkdirSync(sessionCwd, { recursive: true });
    mkdirSync(path.dirname(path.join(repoRoot, targetRelativePath)), { recursive: true });
    mkdirSync(path.dirname(path.join(repoRoot, outsideRelativePath)), { recursive: true });

    execFileSync("git", ["init"], { cwd: repoRoot, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "RAH Test"], { cwd: repoRoot, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "rah@example.com"], { cwd: repoRoot, stdio: "ignore" });

    writeFileSync(path.join(repoRoot, targetRelativePath), "pub fn in_scope() {}\n", "utf8");
    writeFileSync(path.join(repoRoot, outsideRelativePath), "pub fn outside_scope() {}\n", "utf8");
    execFileSync("git", ["add", "."], { cwd: repoRoot, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "init"], { cwd: repoRoot, stdio: "ignore" });

    writeFileSync(path.join(repoRoot, targetRelativePath), "pub fn in_scope() {\n    println!(\"changed in scope\");\n}\n", "utf8");
    writeFileSync(path.join(repoRoot, outsideRelativePath), "pub fn outside_scope() {\n    println!(\"changed outside scope\");\n}\n", "utf8");
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  test("limits git status to the current workspace boundary", () => {
    const status = getCodexGitStatus(sessionCwd);
    assert.deepEqual(
      status.changedFiles,
      [targetRelativePath],
    );
    assert.equal(status.unstagedFiles.length, 1);
    assert.equal(status.unstagedFiles[0]?.path, targetRelativePath);
  });

  test("limits git status to an explicit workspace scope when session cwd is repo root", () => {
    const status = getCodexGitStatus(repoRoot, { scopeRoot: sessionCwd });
    assert.deepEqual(status.changedFiles, [targetRelativePath]);
    assert.equal(status.unstagedFiles.length, 1);
    assert.equal(status.unstagedFiles[0]?.path, targetRelativePath);
  });

  test("reads repo-root-relative file paths from a nested session cwd", () => {
    const file = readWorkspaceFile(sessionCwd, targetRelativePath);
    assert.equal(file.binary, false);
    assert.match(file.content, /changed in scope/);
    assert.ok(file.path.endsWith(targetRelativePath));
  });

  test("rejects reading files outside the current workspace boundary", () => {
    assert.throws(
      () => readWorkspaceFile(sessionCwd, "README.md"),
      /ENOENT|Path must remain inside the workspace/,
    );
    assert.throws(
      () => readWorkspaceFile(sessionCwd, outsideRelativePath),
      /ENOENT|Path must remain inside the workspace/,
    );
  });

  test("rejects reading files outside an explicit workspace scope", () => {
    const file = readWorkspaceFile(repoRoot, targetRelativePath, { scopeRoot: sessionCwd });
    assert.equal(file.binary, false);
    assert.match(file.content, /changed in scope/);
    assert.throws(
      () => readWorkspaceFile(repoRoot, outsideRelativePath, { scopeRoot: sessionCwd }),
      /ENOENT|Path must remain inside the workspace/,
    );
  });

  test("reads git diff for repo-root-relative paths from a nested session cwd", () => {
    const diff = getCodexGitDiff(sessionCwd, targetRelativePath);
    assert.match(diff, /crates\/solars-time\/src\/lib\.rs/);
    assert.match(diff, /\+    println!\("changed in scope"\);/);
  });

  test("stages, reverts, and unstages individual hunks", () => {
    const multiHunkPath = path.join("src", "multi.rs");
    writeFileSync(
      path.join(sessionCwd, multiHunkPath),
      ["one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"].join("\n") + "\n",
      "utf8",
    );
    execFileSync("git", ["add", "."], { cwd: repoRoot, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "multi"], { cwd: repoRoot, stdio: "ignore" });
    writeFileSync(
      path.join(sessionCwd, multiHunkPath),
      ["one changed", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten changed"].join("\n") + "\n",
      "utf8",
    );

    applyCodexGitHunkAction(sessionCwd, {
      path: multiHunkPath,
      hunkIndex: 0,
      action: "stage",
      staged: false,
    });

    const stagedDiff = getCodexGitDiff(sessionCwd, multiHunkPath, { staged: true });
    const unstagedDiff = getCodexGitDiff(sessionCwd, multiHunkPath, { staged: false });
    assert.match(stagedDiff, /one changed/);
    assert.doesNotMatch(stagedDiff, /ten changed/);
    assert.match(unstagedDiff, /ten changed/);

    applyCodexGitHunkAction(sessionCwd, {
      path: multiHunkPath,
      hunkIndex: 0,
      action: "revert",
      staged: false,
    });
    const afterRevert = getCodexGitDiff(sessionCwd, multiHunkPath, { staged: false });
    assert.doesNotMatch(afterRevert, /ten changed/);

    applyCodexGitHunkAction(sessionCwd, {
      path: multiHunkPath,
      hunkIndex: 0,
      action: "unstage",
      staged: true,
    });
    const afterUnstage = getCodexGitDiff(sessionCwd, multiHunkPath, { staged: true });
    assert.equal(afterUnstage, "");
  });

  test("stages and unstages an entire file", () => {
    const filePath = path.join("src", "file_action.rs");
    writeFileSync(
      path.join(sessionCwd, filePath),
      "pub fn file_action() {\n    println!(\"before\");\n}\n",
      "utf8",
    );
    execFileSync("git", ["add", "."], { cwd: repoRoot, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "file-action"], { cwd: repoRoot, stdio: "ignore" });
    writeFileSync(
      path.join(sessionCwd, filePath),
      "pub fn file_action() {\n    println!(\"after\");\n}\n",
      "utf8",
    );

    applyCodexGitFileAction(sessionCwd, {
      path: filePath,
      action: "stage",
      staged: false,
    });
    assert.match(getCodexGitDiff(sessionCwd, filePath, { staged: true }), /after/);
    assert.equal(getCodexGitDiff(sessionCwd, filePath, { staged: false }), "");

    applyCodexGitFileAction(sessionCwd, {
      path: filePath,
      action: "unstage",
      staged: true,
    });
    assert.equal(getCodexGitDiff(sessionCwd, filePath, { staged: true }), "");
    assert.match(getCodexGitDiff(sessionCwd, filePath, { staged: false }), /after/);
  });

  test("reports rename metadata for staged renamed files", () => {
    const oldPath = path.join("src", "rename_before.rs");
    const newPath = path.join("src", "rename_after.rs");
    const oldRepoPath = path.relative(repoRoot, path.join(sessionCwd, oldPath));
    const newRepoPath = path.relative(repoRoot, path.join(sessionCwd, newPath));
    writeFileSync(path.join(sessionCwd, oldPath), "pub fn renamed() {}\n", "utf8");
    execFileSync("git", ["add", "."], { cwd: repoRoot, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "rename-base"], { cwd: repoRoot, stdio: "ignore" });

    execFileSync("git", ["mv", oldPath, newPath], { cwd: sessionCwd, stdio: "ignore" });

    const status = getCodexGitStatus(sessionCwd);
    const renamed = status.stagedFiles.find((entry) => entry.path === newRepoPath);
    assert.ok(renamed);
    assert.equal(renamed?.status, "renamed");
    assert.equal(renamed?.oldPath, oldRepoPath);
  });

  test("marks binary files in git status", () => {
    const binaryPath = path.join("src", "blob.bin");
    const binaryRepoPath = path.relative(repoRoot, path.join(sessionCwd, binaryPath));
    writeFileSync(path.join(sessionCwd, binaryPath), Buffer.from([0, 1, 2, 3]));
    execFileSync("git", ["add", "."], { cwd: repoRoot, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "binary-base"], { cwd: repoRoot, stdio: "ignore" });

    writeFileSync(path.join(sessionCwd, binaryPath), Buffer.from([4, 5, 6, 7]));

    const status = getCodexGitStatus(sessionCwd);
    const binary = status.unstagedFiles.find((entry) => entry.path === binaryRepoPath);
    assert.ok(binary);
    assert.equal(binary?.binary, true);
  });

  test("keeps the same file visible in both staged and unstaged sections", () => {
    const dualPath = path.join("src", "dual_stage.rs");
    const dualRepoPath = path.relative(repoRoot, path.join(sessionCwd, dualPath));
    writeFileSync(path.join(sessionCwd, dualPath), "pub fn dual() {\n    println!(\"base\");\n}\n", "utf8");
    execFileSync("git", ["add", "."], { cwd: repoRoot, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "dual-base"], { cwd: repoRoot, stdio: "ignore" });

    writeFileSync(path.join(sessionCwd, dualPath), "pub fn dual() {\n    println!(\"staged\");\n}\n", "utf8");
    execFileSync("git", ["add", "--", dualPath], { cwd: sessionCwd, stdio: "ignore" });
    writeFileSync(path.join(sessionCwd, dualPath), "pub fn dual() {\n    println!(\"staged\");\n    println!(\"unstaged\");\n}\n", "utf8");

    const status = getCodexGitStatus(sessionCwd);
    assert.ok(status.stagedFiles.some((entry) => entry.path === dualRepoPath));
    assert.ok(status.unstagedFiles.some((entry) => entry.path === dualRepoPath));
  });

  test("frozen Codex history loader keeps browsing anchored after newer rollout lines append", () => {
    const rolloutPath = path.join(repoRoot, "rollout-test.jsonl");
    const lines = Array.from({ length: 400 }, (_, index) => {
      const n = index + 1;
      const minute = String(Math.floor((index * 2) / 60)).padStart(2, "0");
      const userSecond = String((index * 2) % 60).padStart(2, "0");
      const assistantSecond = String((index * 2 + 1) % 60).padStart(2, "0");
      return [
        {
          type: "response_item",
          timestamp: `2025-07-19T22:${minute}:${userSecond}.000Z`,
          payload: {
            type: "message",
            role: "user",
            id: `user-${n}`,
            content: [{ type: "input_text", text: `user ${n}` }],
          },
        },
        {
          type: "response_item",
          timestamp: `2025-07-19T22:${minute}:${assistantSecond}.000Z`,
          payload: {
            type: "message",
            role: "assistant",
            id: `assistant-${n}`,
            content: [{ type: "output_text", text: `assistant ${n}` }],
          },
        },
      ];
    }).flat();
    writeFileSync(
      rolloutPath,
      `${[
        {
          type: "session_meta",
          payload: {
            id: "provider-1",
            cwd: repoRoot,
            timestamp: "2025-07-19T22:00:00.000Z",
          },
        },
        ...lines,
      ].map((line) => JSON.stringify(line)).join("\n")}\n`,
      "utf8",
    );

    const record: CodexStoredSessionRecord = {
      ref: {
        provider: "codex",
        providerSessionId: "provider-1",
        cwd: repoRoot,
        rootDir: repoRoot,
        title: "rollout test",
        preview: "rollout test",
        updatedAt: "2025-07-19T22:59:59.000Z",
        source: "provider_history",
      },
      rolloutPath,
    };

    const loader = createCodexStoredSessionFrozenHistoryPageLoader({
      sessionId: "replay-1",
      record,
    });

    const initial = loader.loadInitialPage(2);
    assert.deepEqual(timelineTexts(initial.events), ["user 400", "assistant 400"]);
    assert.ok(initial.nextCursor);

    const olderBeforeAppend = loader.loadOlderPage(initial.nextCursor!, 2, initial.boundary);

    writeFileSync(
      rolloutPath,
      `${[
        {
          type: "session_meta",
          payload: {
            id: "provider-1",
            cwd: repoRoot,
            timestamp: "2025-07-19T22:00:00.000Z",
          },
        },
        ...lines,
        {
          type: "response_item",
          timestamp: "2025-07-19T23:59:58.000Z",
          payload: {
            type: "message",
            role: "user",
            id: "user-401",
            content: [{ type: "input_text", text: "user 401" }],
          },
        },
        {
          type: "response_item",
          timestamp: "2025-07-19T23:59:59.000Z",
          payload: {
            type: "message",
            role: "assistant",
            id: "assistant-401",
            content: [{ type: "output_text", text: "assistant 401" }],
          },
        },
      ].map((line) => JSON.stringify(line)).join("\n")}\n`,
      "utf8",
    );

    const older = loader.loadOlderPage(initial.nextCursor!, 2, initial.boundary);
    assert.deepEqual(timelineTexts(older.events), timelineTexts(olderBeforeAppend.events));
    assert.ok(older.nextCursor);
    assert.ok(olderBeforeAppend.nextCursor);
    assert.equal(older.nextBeforeTs, olderBeforeAppend.nextBeforeTs);
    assert.deepEqual(older.boundary, olderBeforeAppend.boundary);

    const initialAgain = loader.loadInitialPage(2);
    assert.deepEqual(timelineTexts(initialAgain.events), ["user 400", "assistant 400"]);
  });
});

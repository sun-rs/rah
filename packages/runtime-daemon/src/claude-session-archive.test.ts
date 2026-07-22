import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ClaudeSessionArchiveStore } from "./claude-session-archive";

test("Claude archive physically isolates JSONL and restores it to the exact source path", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "rah-claude-archive-"));
  const claudeConfigDir = path.join(root, "claude");
  const projectDir = path.join(claudeConfigDir, "projects", "-tmp-project");
  const originalPath = path.join(projectDir, "session-1.jsonl");
  const archiveRoot = path.join(root, "rah-archive");
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(originalPath, '{"type":"user","message":{"content":"你好"}}\n');

  try {
    const store = new ClaudeSessionArchiveStore({
      rootDir: archiveRoot,
      claudeConfigDir,
    });
    const archived = await store.archive({
      filePath: originalPath,
      ref: {
        provider: "claude",
        providerSessionId: "session-1",
        source: "provider_history",
        cwd: "/tmp/project",
        historyMeta: { bytes: Buffer.byteLength(readFileSync(originalPath)) },
      },
    });

    assert.equal(existsSync(originalPath), false);
    assert.equal(existsSync(archived.archivedPath), true);
    assert.equal(archived.originalPath, originalPath);
    assert.match(archived.sha256 ?? "", /^[a-f0-9]{64}$/);
    const manifest = JSON.parse(
      readFileSync(path.join(archiveRoot, "manifest.json"), "utf8"),
    ) as { entries: Array<{ originalPath: string; state: string }> };
    assert.equal(manifest.entries[0]?.originalPath, originalPath);
    assert.equal(manifest.entries[0]?.state, "archived");

    await store.restore("session-1");
    assert.equal(existsSync(originalPath), true);
    assert.equal(existsSync(archived.archivedPath), false);
    assert.equal(store.find("session-1"), undefined);
    assert.match(readFileSync(originalPath, "utf8"), /你好/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Claude restore refuses to overwrite a recreated provider history file", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "rah-claude-archive-conflict-"));
  const claudeConfigDir = path.join(root, "claude");
  const projectDir = path.join(claudeConfigDir, "projects", "-tmp-project");
  const originalPath = path.join(projectDir, "session-2.jsonl");
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(originalPath, "original\n");

  try {
    const store = new ClaudeSessionArchiveStore({
      rootDir: path.join(root, "rah-archive"),
      claudeConfigDir,
    });
    const archived = await store.archive({
      filePath: originalPath,
      ref: {
        provider: "claude",
        providerSessionId: "session-2",
        source: "provider_history",
      },
    });
    writeFileSync(originalPath, "new provider data\n");

    await assert.rejects(
      store.restore("session-2"),
      /restore target already exists/,
    );
    assert.equal(readFileSync(originalPath, "utf8"), "new provider data\n");
    assert.equal(existsSync(archived.archivedPath), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

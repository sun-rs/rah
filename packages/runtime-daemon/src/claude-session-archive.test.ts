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

test("Claude archive recovers a verified cross-filesystem copy left before source unlink", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "rah-claude-archive-recover-copy-"));
  const claudeConfigDir = path.join(root, "claude");
  const originalPath = path.join(
    claudeConfigDir,
    "projects",
    "-tmp-project",
    "session-copy.jsonl",
  );
  const archiveRoot = path.join(root, "rah-archive");
  const archivedPath = path.join(
    archiveRoot,
    "files",
    "session-copy",
    "session-copy.jsonl",
  );
  const content = '{"type":"user","message":{"content":"copy"}}\n';
  mkdirSync(path.dirname(originalPath), { recursive: true });
  mkdirSync(path.dirname(archivedPath), { recursive: true });
  writeFileSync(originalPath, content);
  writeFileSync(archivedPath, content);
  writeFileSync(path.join(archiveRoot, "manifest.json"), JSON.stringify({
    version: 1,
    updatedAt: new Date().toISOString(),
    entries: [{
      provider: "claude",
      providerSessionId: "session-copy",
      originalPath,
      archivedPath,
      archivedAt: new Date().toISOString(),
      sizeBytes: Buffer.byteLength(content),
      mtimeMs: Date.now(),
      state: "pending_archive",
      snapshot: {
        provider: "claude",
        providerSessionId: "session-copy",
        source: "provider_history",
      },
    }],
  }));

  try {
    const store = new ClaudeSessionArchiveStore({ rootDir: archiveRoot, claudeConfigDir });
    const recovered = store.find("session-copy");
    assert.equal(existsSync(originalPath), false);
    assert.equal(existsSync(archivedPath), true);
    assert.equal(recovered?.state, "archived");
    assert.match(recovered?.sha256 ?? "", /^[a-f0-9]{64}$/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Claude restore recovers a verified cross-filesystem copy left before archive unlink", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "rah-claude-restore-recover-copy-"));
  const claudeConfigDir = path.join(root, "claude");
  const originalPath = path.join(
    claudeConfigDir,
    "projects",
    "-tmp-project",
    "session-restore.jsonl",
  );
  const archiveRoot = path.join(root, "rah-archive");
  const archivedPath = path.join(
    archiveRoot,
    "files",
    "session-restore",
    "session-restore.jsonl",
  );
  const content = '{"type":"user","message":{"content":"restore"}}\n';
  mkdirSync(path.dirname(originalPath), { recursive: true });
  mkdirSync(path.dirname(archivedPath), { recursive: true });
  writeFileSync(originalPath, content);
  writeFileSync(archivedPath, content);
  writeFileSync(path.join(archiveRoot, "manifest.json"), JSON.stringify({
    version: 1,
    updatedAt: new Date().toISOString(),
    entries: [{
      provider: "claude",
      providerSessionId: "session-restore",
      originalPath,
      archivedPath,
      archivedAt: new Date().toISOString(),
      sizeBytes: Buffer.byteLength(content),
      mtimeMs: Date.now(),
      state: "pending_restore",
      snapshot: {
        provider: "claude",
        providerSessionId: "session-restore",
        source: "provider_history",
      },
    }],
  }));

  try {
    const store = new ClaudeSessionArchiveStore({ rootDir: archiveRoot, claudeConfigDir });
    assert.equal(existsSync(originalPath), true);
    assert.equal(existsSync(archivedPath), false);
    assert.equal(store.find("session-restore"), undefined);
    assert.equal(readFileSync(originalPath, "utf8"), content);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

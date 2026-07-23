import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { historyMetaForFileSync } from "./stored-session-history-meta";

test("stored history metadata uses constant-time file size without counting lines", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "rah-history-meta-"));
  try {
    const filePath = path.join(root, "session.jsonl");
    writeFileSync(filePath, "one\ntwo\nthree\n", "utf8");

    assert.deepEqual(historyMetaForFileSync(filePath), {
      bytes: Buffer.byteLength("one\ntwo\nthree\n"),
    });
    assert.deepEqual(historyMetaForFileSync(filePath, undefined, {
      messages: 3,
      lines: 3,
    }), {
      bytes: Buffer.byteLength("one\ntwo\nthree\n"),
      messages: 3,
      lines: 3,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

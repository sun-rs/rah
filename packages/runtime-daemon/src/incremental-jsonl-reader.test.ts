import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, renameSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  createIncrementalJsonlCursor,
  readIncrementalJsonlBatch,
} from "./incremental-jsonl-reader";

test("reads only appended complete JSONL lines and preserves a partial tail", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "rah-jsonl-tail-"));
  const filePath = path.join(dir, "rollout.jsonl");
  writeFileSync(filePath, "{\"id\":1}\n{\"id\":");
  const cursor = createIncrementalJsonlCursor();

  assert.deepEqual((await readIncrementalJsonlBatch(filePath, cursor)).lines, [
    "{\"id\":1}",
  ]);
  appendFileSync(filePath, "2}\n");
  assert.deepEqual((await readIncrementalJsonlBatch(filePath, cursor)).lines, [
    "{\"id\":2}",
  ]);
  assert.deepEqual((await readIncrementalJsonlBatch(filePath, cursor)).lines, []);
});

test("enforces byte and line budgets without losing unread bytes", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "rah-jsonl-budget-"));
  const filePath = path.join(dir, "rollout.jsonl");
  writeFileSync(filePath, "a\nb\nc\nd\n");
  const cursor = createIncrementalJsonlCursor();

  const first = await readIncrementalJsonlBatch(filePath, cursor, {
    maxBytes: 8,
    maxLines: 2,
  });
  assert.deepEqual(first.lines, ["a", "b"]);
  assert.equal(first.hasMore, true);
  const second = await readIncrementalJsonlBatch(filePath, cursor, {
    maxBytes: 8,
    maxLines: 2,
  });
  assert.deepEqual(second.lines, ["c", "d"]);
  assert.equal(second.hasMore, false);
});

test("drops an oversized line and resumes at the next newline", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "rah-jsonl-oversized-"));
  const filePath = path.join(dir, "rollout.jsonl");
  writeFileSync(filePath, `${"x".repeat(64)}\n{\"ok\":true}\n`);
  const cursor = createIncrementalJsonlCursor();
  const lines: string[] = [];
  let dropped = 0;
  do {
    const batch = await readIncrementalJsonlBatch(filePath, cursor, {
      maxBytes: 16,
      maxLineBytes: 24,
    });
    lines.push(...batch.lines);
    dropped += batch.droppedOversizedLines;
    if (!batch.hasMore) {
      break;
    }
  } while (true);

  assert.deepEqual(lines, ["{\"ok\":true}"]);
  assert.equal(dropped, 1);
});

test("resets safely when the provider replaces the rollout file", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "rah-jsonl-replace-"));
  const filePath = path.join(dir, "rollout.jsonl");
  const replacementPath = path.join(dir, "replacement.jsonl");
  writeFileSync(filePath, "old\n");
  const cursor = createIncrementalJsonlCursor();
  assert.deepEqual((await readIncrementalJsonlBatch(filePath, cursor)).lines, ["old"]);

  writeFileSync(replacementPath, "new\n");
  renameSync(replacementPath, filePath);
  assert.deepEqual((await readIncrementalJsonlBatch(filePath, cursor)).lines, ["new"]);
});

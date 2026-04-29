import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  canFinalizeCodexStoredHistory,
  externalWriterRecordsFromLsofOutput,
  hasExternalWriterFromLsofOutput,
  parseLsofFileRecords,
  parseProcessParentRecords,
  processTableHasDescendantOf,
} from "./codex-history-liveness";

describe("codex history liveness", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function writeRolloutWithMtime(mtimeMs: number): string {
    const dir = mkdtempSync(path.join(os.tmpdir(), "rah-codex-liveness-"));
    tempDirs.push(dir);
    const file = path.join(dir, "rollout.jsonl");
    writeFileSync(file, "\n", "utf8");
    const atime = new Date(mtimeMs);
    const mtime = new Date(mtimeMs);
    utimesSync(file, atime, mtime);
    return file;
  }

  test("parses lsof file records and detects write-capable external owners", () => {
    const output = [
      `p${process.pid}`,
      "cnode",
      "f20",
      "au",
      "p12345",
      "ccodex",
      "f8",
      "ar",
      "p12346",
      "ccodex",
      "f9",
      "aw",
      "",
    ].join("\n");

    assert.deepEqual(parseLsofFileRecords(output), [
      { pid: process.pid, command: "node", fd: "20", access: "u" },
      { pid: 12345, command: "codex", fd: "8", access: "r" },
      { pid: 12346, command: "codex", fd: "9", access: "w" },
    ]);
    assert.equal(hasExternalWriterFromLsofOutput(output), true);
    assert.deepEqual(externalWriterRecordsFromLsofOutput(output), [
      { pid: 12346, command: "codex", fd: "9", access: "w" },
    ]);
  });

  test("ignores self and read-only lsof owners", () => {
    const output = [
      `p${process.pid}`,
      "cnode",
      "f20",
      "au",
      "p12345",
      "ccodex",
      "f8",
      "ar",
      "",
    ].join("\n");

    assert.equal(hasExternalWriterFromLsofOutput(output), false);
  });

  test("parses process parent records and detects descendants", () => {
    const output = [
      "12345     1",
      "12346 12345",
      "12347 12346",
      "not-a-process",
      "",
    ].join("\n");

    assert.deepEqual(parseProcessParentRecords(output), [
      { pid: 12345, ppid: 1 },
      { pid: 12346, ppid: 12345 },
      { pid: 12347, ppid: 12346 },
    ]);
    assert.equal(processTableHasDescendantOf([12345], output), true);
    assert.equal(processTableHasDescendantOf([99999], output), false);
  });

  test("finalizes only when there is no managed writer, no active external writer, and the file is stable", () => {
    const rolloutPath = writeRolloutWithMtime(1_000);

    assert.equal(
      canFinalizeCodexStoredHistory({
        rolloutPath,
        hasRahManagedWriter: false,
        nowMs: 4_000,
        stableMs: 2_000,
        lsofOutput: "",
      }),
      true,
    );
    assert.equal(
      canFinalizeCodexStoredHistory({
        rolloutPath,
        hasRahManagedWriter: true,
        nowMs: 4_000,
        stableMs: 2_000,
        lsofOutput: "",
      }),
      false,
    );
    assert.equal(
      canFinalizeCodexStoredHistory({
        rolloutPath,
        hasRahManagedWriter: false,
        nowMs: 4_000,
        stableMs: 2_000,
        lsofOutput: "p12345\ncnode\nf8\nau\n",
      }),
      false,
    );
    assert.equal(
      canFinalizeCodexStoredHistory({
        rolloutPath,
        hasRahManagedWriter: false,
        nowMs: 2_000,
        stableMs: 2_000,
        lsofOutput: "",
      }),
      false,
    );
  });

  test("allows stable idle Codex TUI writers but blocks writers with active child processes", () => {
    const rolloutPath = writeRolloutWithMtime(1_000);
    const lsofOutput = "p12345\nccodex-aarch64-apple-darwin\nf8\naw\n";

    assert.equal(
      canFinalizeCodexStoredHistory({
        rolloutPath,
        hasRahManagedWriter: false,
        nowMs: 4_000,
        stableMs: 2_000,
        lsofOutput,
        psOutput: "12345 1\n",
      }),
      true,
    );
    assert.equal(
      canFinalizeCodexStoredHistory({
        rolloutPath,
        hasRahManagedWriter: false,
        nowMs: 4_000,
        stableMs: 2_000,
        lsofOutput,
        psOutput: "12345 1\n12346 12345\n",
      }),
      false,
    );
  });
});

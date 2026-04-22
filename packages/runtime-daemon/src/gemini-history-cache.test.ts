import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { RahEvent } from "@rah/runtime-protocol";
import {
  loadCachedGeminiHistoryEvents,
  loadCachedGeminiHistoryWindow,
  writeCachedGeminiHistoryEvents,
} from "./gemini-history-cache";

function historyEvent(sessionId: string, seq: number): RahEvent {
  const second = String((seq % 60) + 1).padStart(2, "0");
  return {
    id: `${sessionId}-${seq}`,
    seq,
    ts: `2025-07-19T22:21:${second}.000Z`,
    sessionId,
    type: "timeline.item.added",
    source: {
      provider: "gemini",
      channel: "structured_persisted",
      authority: "authoritative",
    },
    payload: {
      item: {
        kind: "assistant_message",
        text: `message ${seq}`,
      },
    },
  };
}

describe("gemini history cache", () => {
  let tmpRahHome: string;
  let previousRahHome: string | undefined;

  beforeEach(() => {
    previousRahHome = process.env.RAH_HOME;
    tmpRahHome = mkdtempSync(path.join(os.tmpdir(), "rah-gemini-cache-"));
    process.env.RAH_HOME = tmpRahHome;
  });

  afterEach(() => {
    if (previousRahHome === undefined) {
      delete process.env.RAH_HOME;
    } else {
      process.env.RAH_HOME = previousRahHome;
    }
    rmSync(tmpRahHome, { recursive: true, force: true });
  });

  test("stores Gemini history as multiple pages and loads windows without full flattening", () => {
    const filePath = path.join(tmpRahHome, "session.jsonl");
    writeFileSync(filePath, "{}\n");
    const events = Array.from({ length: 600 }, (_, index) => historyEvent("gemini-session", index + 1));

    writeCachedGeminiHistoryEvents({
      filePath,
      size: 1024,
      mtimeMs: 1700000000000,
      events,
    });

    const cacheEntries = readdirSync(path.join(tmpRahHome, "gemini-history-cache"));
    assert.equal(cacheEntries.length, 1);
    const cacheDir = path.join(tmpRahHome, "gemini-history-cache", cacheEntries[0]!);
    assert.deepEqual(
      readdirSync(cacheDir).sort(),
      ["manifest.json", "page-0.json", "page-1.json", "page-2.json"],
    );

    const window = loadCachedGeminiHistoryWindow({
      filePath,
      size: 1024,
      mtimeMs: 1700000000000,
      startOffset: 510,
      endOffset: 600,
    });
    assert.ok(window);
    assert.equal(window.totalEvents, 600);
    assert.equal(window.events.length, 90);
    assert.equal(window.events[0]?.id, "gemini-session-511");
    assert.equal(window.events.at(-1)?.id, "gemini-session-600");

    const full = loadCachedGeminiHistoryEvents({
      filePath,
      size: 1024,
      mtimeMs: 1700000000000,
    });
    assert.equal(full?.length, 600);
  });

  test("treats size or mtime drift as cache miss", () => {
    const filePath = path.join(tmpRahHome, "session.jsonl");
    writeFileSync(filePath, "{}\n");

    writeCachedGeminiHistoryEvents({
      filePath,
      size: 1024,
      mtimeMs: 1700000000000,
      events: [historyEvent("gemini-session", 1)],
    });

    assert.equal(
      loadCachedGeminiHistoryWindow({
        filePath,
        size: 2048,
        mtimeMs: 1700000000000,
        startOffset: 0,
        endOffset: 1,
      }),
      null,
    );
    assert.equal(
      loadCachedGeminiHistoryEvents({
        filePath,
        size: 1024,
        mtimeMs: 1700000000001,
      }),
      null,
    );
  });
});

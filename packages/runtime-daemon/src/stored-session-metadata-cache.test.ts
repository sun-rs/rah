import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { StoredSessionCatalogRecord } from "./stored-session-catalog-types";
import {
  loadStoredSessionCatalogCache,
  loadStoredSessionCatalogSnapshot,
  writeStoredSessionCatalogSnapshot,
  writeStoredSessionMetadataCache,
} from "./stored-session-metadata-cache";

function record(providerSessionId: string): StoredSessionCatalogRecord {
  return {
    ref: {
      provider: "codex",
      providerSessionId,
      cwd: "/workspace/demo",
      rootDir: "/workspace/demo",
      title: providerSessionId,
      source: "provider_history",
    },
    storagePath: `/history/${providerSessionId}.jsonl`,
    archived: false,
  };
}

test("catalog startup ignores snapshots and metadata from an older visibility contract", async () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "rah-catalog-snapshot-"));
  const previousRahHome = process.env.RAH_HOME;
  process.env.RAH_HOME = tempDir;
  try {
    const cacheDir = path.join(tempDir, "stored-session-cache");
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(
      path.join(cacheDir, "catalog.json"),
      JSON.stringify({
        version: 2,
        records: [record("stale-chat")],
      }),
    );
    assert.deepEqual(loadStoredSessionCatalogSnapshot(), []);

    writeStoredSessionMetadataCache(
      "codex",
      new Map([
        [
          "/history/stale-chat.jsonl",
          {
            ref: record("stale-chat").ref,
            size: 100,
            mtimeMs: 200,
            version: 4,
          },
        ],
        [
          "/history/current-task.jsonl",
          {
            ref: record("current-task").ref,
            size: 300,
            mtimeMs: 400,
            version: 5,
          },
        ],
      ]),
    );
    assert.deepEqual(
      loadStoredSessionCatalogCache("codex", { entryVersion: 5 }).map(
        (item) => item.ref.providerSessionId,
      ),
      ["current-task"],
    );

    await writeStoredSessionCatalogSnapshot([record("current-task")]);
    assert.deepEqual(
      loadStoredSessionCatalogSnapshot().map(
        (item) => item.ref.providerSessionId,
      ),
      ["current-task"],
    );
    assert.equal(
      (JSON.parse(
        readFileSync(path.join(cacheDir, "catalog.json"), "utf8"),
      ) as { version: number }).version,
      3,
    );
  } finally {
    if (previousRahHome === undefined) {
      delete process.env.RAH_HOME;
    } else {
      process.env.RAH_HOME = previousRahHome;
    }
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("catalog snapshot load and persistence enforce one canonical row per identity", async () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "rah-catalog-canonical-"));
  const previousRahHome = process.env.RAH_HOME;
  process.env.RAH_HOME = tempDir;
  try {
    await writeStoredSessionCatalogSnapshot([
      {
        ...record("duplicate"),
        storagePath: "/archive/duplicate.jsonl",
        archived: true,
      },
      {
        ...record("duplicate"),
        storagePath: "/history/duplicate.jsonl",
        archived: false,
      },
      record(" "),
    ]);

    const loaded = loadStoredSessionCatalogSnapshot();
    assert.equal(loaded.length, 1);
    assert.equal(loaded[0]?.storagePath, "/history/duplicate.jsonl");
    const persisted = JSON.parse(
      readFileSync(
        path.join(tempDir, "stored-session-cache", "catalog.json"),
        "utf8",
      ),
    ) as { records: StoredSessionCatalogRecord[] };
    assert.equal(persisted.records.length, 1);
  } finally {
    if (previousRahHome === undefined) {
      delete process.env.RAH_HOME;
    } else {
      process.env.RAH_HOME = previousRahHome;
    }
    rmSync(tempDir, { recursive: true, force: true });
  }
});

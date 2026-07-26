import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  readStoredSessionCatalogTransfer,
  StoredSessionCatalog,
} from "./stored-session-catalog";
import type { StoredSessionCatalogTransferRow } from "./stored-session-catalog-types";

const ENV_KEYS = ["CODEX_HOME", "CLAUDE_CONFIG_DIR", "XDG_DATA_HOME", "RAH_HOME"] as const;

let root: string;
let previousEnvironment: Partial<Record<(typeof ENV_KEYS)[number], string>>;

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "rah-stored-catalog-"));
  previousEnvironment = {};
  for (const key of ENV_KEYS) {
    if (process.env[key] !== undefined) {
      previousEnvironment[key] = process.env[key];
    }
  }
  process.env.CODEX_HOME = path.join(root, "codex");
  process.env.CLAUDE_CONFIG_DIR = path.join(root, "claude");
  process.env.XDG_DATA_HOME = path.join(root, "xdg");
  process.env.RAH_HOME = path.join(root, "rah");
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const previous = previousEnvironment[key];
    if (previous === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = previous;
    }
  }
  rmSync(root, { recursive: true, force: true });
});

function writeCodexRollout(): { sessionId: string; rolloutPath: string } {
  const sessionId = "019e2222-aaaa-7bbb-8ccc-ddddeeeeffff";
  const cwd = path.join(root, "workspace");
  const directory = path.join(process.env.CODEX_HOME!, "sessions", "2026", "07", "13");
  mkdirSync(directory, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  const rolloutPath = path.join(
    directory,
    `rollout-2026-07-13T00-00-00-${sessionId}.jsonl`,
  );
  writeFileSync(
    rolloutPath,
    [
      JSON.stringify({
        timestamp: "2026-07-13T00:00:00.000Z",
        type: "session_meta",
        payload: {
          id: sessionId,
          timestamp: "2026-07-13T00:00:00.000Z",
          cwd,
          source: "cli",
        },
      }),
      JSON.stringify({
        timestamp: "2026-07-13T00:00:01.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "catalog worker question" }],
        },
      }),
    ].join("\n") + "\n",
  );
  return { sessionId, rolloutPath };
}

test("discovers provider catalogs off the main runtime path", async () => {
  const expected = writeCodexRollout();
  const catalog = new StoredSessionCatalog();
  try {
    const results = await catalog.refresh("codex");
    assert.equal(results.length, 1);
    assert.equal(results[0]?.provider, "codex");
    assert.equal(results[0]?.complete, true);
    assert.equal(results[0]?.error, undefined);
    assert.equal(results[0]?.records?.[0]?.ref.providerSessionId, expected.sessionId);
    assert.equal(results[0]?.records?.[0]?.storagePath, expected.rolloutPath);
  } finally {
    await catalog.shutdown();
  }
});

test("isolates one provider discovery failure from the other catalogs", async () => {
  const expected = writeCodexRollout();
  mkdirSync(path.join(process.env.CLAUDE_CONFIG_DIR!, "projects"), { recursive: true });
  const openCodeDir = path.join(process.env.XDG_DATA_HOME!, "opencode");
  mkdirSync(openCodeDir, { recursive: true });
  writeFileSync(path.join(openCodeDir, "opencode.db"), "not a sqlite database");
  const catalog = new StoredSessionCatalog();
  try {
    const results = await catalog.refresh();
    assert.equal(
      results.find((result) => result.provider === "codex")?.records?.[0]?.ref.providerSessionId,
      expected.sessionId,
    );
    assert.deepEqual(
      results.find((result) => result.provider === "claude")?.records,
      [],
    );
    assert.equal(
      results.find((result) => result.provider === "claude")?.complete,
      true,
    );
    assert.equal(
      results.find((result) => result.provider === "opencode")?.complete,
      false,
    );
    assert.match(
      results.find((result) => result.provider === "opencode")?.error ?? "",
      /opencode\.db|sqlite/i,
    );
  } finally {
    await catalog.shutdown();
  }
});

test("reports an unavailable provider root as incomplete instead of an authoritative empty catalog", async () => {
  const catalog = new StoredSessionCatalog();
  try {
    const [result] = await catalog.refresh("codex");
    assert.equal(result?.provider, "codex");
    assert.equal(result?.complete, false);
    assert.deepEqual(result?.records, []);
  } finally {
    await catalog.shutdown();
  }
});

test("shutdown settles an in-flight worker and refuses later refreshes", async () => {
  writeCodexRollout();
  const catalog = new StoredSessionCatalog();
  const inFlight = catalog.refresh();
  await catalog.shutdown();
  await inFlight.catch(() => []);
  assert.deepEqual(await catalog.refresh(), []);
});

test("streams large catalog transfers without monopolizing the daemon event loop", async () => {
  const recordCount = 12_000;
  const transferPath = path.join(root, "large-catalog.jsonl");
  const rows: string[] = [];
  for (let index = 0; index < recordCount; index += 1) {
    rows.push(
      JSON.stringify({
        kind: "record",
        provider: "codex",
        record: {
          ref: {
            provider: "codex",
            providerSessionId: `session-${index}`,
            title: `Catalog session ${index} ${"x".repeat(128)}`,
          },
          storagePath: path.join(root, "sessions", `${index}.jsonl`),
        },
      } satisfies StoredSessionCatalogTransferRow),
    );
  }
  rows.push(
    JSON.stringify({
      kind: "provider",
      provider: "codex",
      complete: true,
    } satisfies StoredSessionCatalogTransferRow),
  );
  const payload = `${rows.join("\n")}\n`;
  writeFileSync(transferPath, payload);

  let heartbeats = 0;
  const heartbeat = setInterval(() => {
    heartbeats += 1;
  }, 1);
  try {
    const [result] = await readStoredSessionCatalogTransfer({
      filePath: transferPath,
      providers: ["codex"],
      expectedRecordCount: recordCount,
      expectedBytes: Buffer.byteLength(payload, "utf8"),
    });
    assert.equal(result?.complete, true);
    assert.equal(result?.records?.length, recordCount);
    assert.equal(
      result?.records?.at(-1)?.ref.providerSessionId,
      `session-${recordCount - 1}`,
    );
    assert.ok(
      heartbeats > 0,
      "catalog parsing should yield while the event-loop heartbeat is active",
    );
  } finally {
    clearInterval(heartbeat);
  }
});

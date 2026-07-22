import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { StoredSessionCatalog } from "./stored-session-catalog";

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
